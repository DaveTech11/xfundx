const cfg = require('./config');
const { saveUsers, db, saveProofHashes } = require('./store');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PROOF_DIR = path.join(__dirname, 'data', 'proofs');
fs.mkdirSync(PROOF_DIR, { recursive:true });
const { addPoints } = require('./rewards');
const { telegramApi, telegramSendPhotoBuffer } = require('./telegram');

// Every platform we run a "follow/join + screenshot proof" task for.
// Adding a new platform later just means adding an entry here.
const PLATFORMS = {};
const socialTasks = [
  ...(cfg.YOUTUBE_TASKS || []).map(t => ({...t, platform:'youtube'})),
  ...(cfg.TIKTOK_TASKS || []).map(t => ({...t, platform:'tiktok'}))
];
for (const t of socialTasks) {
  PLATFORMS[t.id] = {
    stateField: `${t.id}Task`,
    reasonKey: `${t.platform}_${t.id}`,
    actionWord: t.platform === 'youtube' ? 'subscribe/join' : 'follow',
    title: () => t.title,
    accountName: () => t.name,
    url: () => t.url,
    reward: () => t.reward,
    minConfidence: () => t.minConfidence
  };
}
// Backward-compatible aliases for existing first-task users.
if (cfg.YOUTUBE_CHANNEL_URL && !PLATFORMS.youtube) {
  PLATFORMS.youtube = {
    stateField:'youtubeTask', reasonKey:'youtube_channel', actionWord:'subscribe/join',
    title:()=>cfg.YOUTUBE_TASK_TITLE, accountName:()=>cfg.YOUTUBE_CHANNEL_NAME,
    url:()=>cfg.YOUTUBE_CHANNEL_URL, reward:()=>cfg.YOUTUBE_TASK_REWARD,
    minConfidence:()=>cfg.YOUTUBE_VISION_MIN_CONFIDENCE
  };
}
if (cfg.TIKTOK_ACCOUNT_URL && !PLATFORMS.tiktok) {
  PLATFORMS.tiktok = {
    stateField:'tiktokTask', reasonKey:'tiktok_follow', actionWord:'follow',
    title:()=>cfg.TIKTOK_TASK_TITLE, accountName:()=>cfg.TIKTOK_ACCOUNT_NAME,
    url:()=>cfg.TIKTOK_ACCOUNT_URL, reward:()=>cfg.TIKTOK_TASK_REWARD,
    minConfidence:()=>cfg.TIKTOK_VISION_MIN_CONFIDENCE
  };
}

function platformDef(platform) {
  const def = PLATFORMS[platform];
  if (!def) throw new Error(`Unknown social platform: ${platform}`);
  return def;
}

function getTask(platform) {
  const def = platformDef(platform);
  return {
    id: platform,
    platform,
    title: def.title(),
    accountName: def.accountName(),
    url: def.url(),
    reward: def.reward()
  };
}

function ensureState(user, platform) {
  const def = platformDef(platform);
  if (!user[def.stateField]) {
    user[def.stateField] = { status: 'not_started', attempts: 0, submittedAt: null, reviewedAt: null, reason: '' };
  }
  return user[def.stateField];
}

function getState(user, platform) { return ensureState(user, platform); }

async function analyzeScreenshotWithVision(imageDataUrl, platform) {
  const def = platformDef(platform);
  if (!cfg.OPENAI_API_KEY) return { status: 'manual', reason: 'Vision AI is not configured.' };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: cfg.OPENAI_VISION_MODEL,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Review this screenshot as evidence for a rewards task. The user was asked to ${def.actionWord} the ${platform === 'youtube' ? 'YouTube channel' : 'TikTok account'} "${def.accountName()}". Determine whether the screenshot visibly shows the correct account/channel and a followed/subscribed/joined state. Look for the account name and a Following/Subscribed/Joined UI state. Do NOT infer that the user completed the action if the evidence is not visible. Return ONLY JSON with keys: decision ("pass"|"manual"|"fail"), confidence (0-1), reason (short). A screenshot alone cannot prove identity or historical actions, so use "manual" if the evidence is ambiguous.`
          },
          { type: 'input_image', image_url: imageDataUrl, detail: 'high' }
        ]
      }]
    })
  });
  if (!response.ok) throw new Error(`Vision API returned ${response.status}`);
  const data = await response.json();
  const text = data.output_text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { status: 'manual', reason: 'Vision response was not valid JSON.' };
  try {
    const parsed = JSON.parse(match[0]);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
    const decision = ['pass', 'manual', 'fail'].includes(parsed.decision) ? parsed.decision : 'manual';
    if (decision === 'pass' && confidence < def.minConfidence()) {
      return { status: 'manual', confidence, reason: 'Evidence looked plausible but confidence was below the automatic approval threshold.' };
    }
    return { status: decision, confidence, reason: String(parsed.reason || '').slice(0, 300) };
  } catch {
    return { status: 'manual', reason: 'Vision response could not be parsed.' };
  }
}

// Core submit path — takes an already-decoded data: URL. Both the
// Telegram photo handler and the web upload endpoint funnel into this,
// so proof review, anti-bypass rules, and rewarding only live in one place.
async function submitImage(user, dataUrl, adminId, platform, telegramFileId = null) {
  const def = platformDef(platform);
  const state = ensureState(user, platform);
  if (state.status === 'approved') return { status: 'approved', reward: 0, message: `${platform} task already completed.` };
  if (state.status === 'pending') return { status: 'pending', reward: 0, message: 'Your proof is already under review.' };
  if (!def.url()) throw new Error(`${platform} task is not configured yet.`);
  const encoded = String(dataUrl).split(',')[1] || '';
  const proofHash = crypto.createHash('sha256').update(Buffer.from(encoded,'base64')).digest('hex');
  db.proofHashes = db.proofHashes || {};
  const existing = db.proofHashes[proofHash];
  if (existing) {
    state.status = 'rejected';
    state.reviewedAt = new Date().toISOString();
    state.reason = `Duplicate screenshot already submitted for ${existing.platform} by user ${existing.userId}.`;
    state.proofHash = proofHash;
    saveUsers();
    return { status:'rejected', reward:0, message:'This screenshot has already been submitted and cannot be reused.' };
  }
  state.proofHash = proofHash;
  const mime = (String(dataUrl).match(/^data:([^;]+);/) || [,'image/jpeg'])[1];
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const proofPath = path.join(PROOF_DIR, `${proofHash}.${ext}`);
  fs.writeFileSync(proofPath, Buffer.from(encoded,'base64'));
  db.proofHashes[proofHash] = { userId:user.id, platform, submittedAt:new Date().toISOString(), path:proofPath, mime };

  saveProofHashes();

  state.attempts = Number(state.attempts || 0) + 1;
  state.submittedAt = new Date().toISOString();
  state.status = 'pending';
  state.reason = '';
  saveUsers();

  let review;
  try { review = await analyzeScreenshotWithVision(dataUrl, platform); }
  catch (e) { review = { status: 'manual', reason: `Vision review unavailable: ${e.message}` }; }

  state.reason = review.reason || '';
  state.visionConfidence = review.confidence || 0;

  if (review.status === 'pass') {
    state.status = 'approved';
    state.reviewedAt = new Date().toISOString();
    addPoints(user, def.reward(), def.reasonKey);
    saveUsers();
    return { status: 'approved', reward: def.reward(), message: `Proof accepted. +${def.reward()} points.` };
  }

  if (review.status === 'fail') {
    state.status = 'rejected';
    state.reviewedAt = new Date().toISOString();
    saveUsers();
    return { status: 'rejected', reward: 0, message: `Proof was not clear enough: ${state.reason || 'the screenshot did not show a followed/subscribed state.'}` };
  }

  // Ambiguous screenshots always go to the admin instead of auto-paying out.
  // This is the "no bypassing" guarantee: without a configured vision
  // model (or when it can't decide), nothing is rewarded automatically.
  if (adminId) {
    const caption = `🧾 <b>${platform === 'youtube' ? 'YouTube' : 'TikTok'} proof review</b>\n\nUser: ${user.username ? '@' + user.username : user.id}\nTask: ${def.accountName()}\nSource: ${user.authSource || 'telegram'}\nAttempt: ${state.attempts}\nAI: ${state.reason || 'Manual review required.'}\nConfidence: ${Math.round((state.visionConfidence || 0) * 100)}%`;
    const replyMarkup = { inline_keyboard: [[
      { text: '✅ Approve + reward', callback_data: `soc_ok:${platform}:${user.id}` },
      { text: '❌ Reject', callback_data: `soc_no:${platform}:${user.id}` }
    ]] };
    try {
      if (telegramFileId) {
        // Came in via the Telegram bot — resend using the existing file_id.
        await telegramApi('sendPhoto', { chat_id: adminId, photo: telegramFileId, caption, parse_mode: 'HTML', reply_markup: replyMarkup });
      } else {
        // Came in from the website — upload the raw bytes instead.
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        const buffer = Buffer.from(match ? match[2] : '', 'base64');
        await telegramSendPhotoBuffer(adminId, buffer, `${platform}-proof.jpg`, { caption, parse_mode: 'HTML', reply_markup: replyMarkup });
      }
    } catch {}
  }
  saveUsers();
  return { status: 'manual', reward: 0, message: 'Your screenshot was received and sent for review. No points are awarded until it is approved.' };
}

// Telegram-specific wrapper: downloads the photo, then defers to submitImage.
async function submitTelegramPhoto(user, photo, adminId, platform) {
  const file = await telegramApi('getFile', { file_id: photo.file_id });
  if (!file?.file_path) throw new Error('Could not read the uploaded screenshot.');
  const imageRes = await fetch(`https://api.telegram.org/file/bot${cfg.BOT_TOKEN}/${file.file_path}`);
  if (!imageRes.ok) throw new Error('Could not download the uploaded screenshot.');
  const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await imageRes.arrayBuffer());
  const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
  return submitImage(user, dataUrl, adminId, platform, photo.file_id);
}

function approve(user, platform) {
  const def = platformDef(platform);
  const state = ensureState(user, platform);
  if (state.status === 'approved') return false;
  state.status = 'approved';
  state.reviewedAt = new Date().toISOString();
  const rewarded = addPoints(user, def.reward(), def.reasonKey);
  saveUsers();
  return rewarded;
}

function reject(user, platform) {
  const state = ensureState(user, platform);
  if (state.status === 'approved') return false;
  state.status = 'rejected';
  state.reviewedAt = new Date().toISOString();
  saveUsers();
  return true;
}

module.exports = { PLATFORMS, getTask, getState, submitImage, submitTelegramPhoto, approve, reject };
