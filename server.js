const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { db, saveUsers, saveWithdrawals, saveAudit, saveProofHashes, savePromos, saveSystem } = require('./store');
const nodemailer = require('nodemailer');
const { validateInitData, validateLoginWidget, checkChannelMembership, telegramApi } = require('./telegram');
const { ensureUser, award, claimVideo, maybeQualifyReferral, referralStats, claimDaily, claimMission, missionStatus, ngnFromPoints, referralCode, addCash, scratchCard, mysteryBox, streakBonus } = require('./rewards');
const engagement = require('./engagement');
const { startPairing, getPairingState, listConnections, disconnect, refreshPairingCode } = require('./whatsapp');
const social = require('./socialProof');
const advanced = require('./advanced');

try { const fp=path.join(__dirname,'data','cash-withdrawals.json'); db.cashWithdrawals=fs.existsSync(fp)?JSON.parse(fs.readFileSync(fp,'utf8')):{}; } catch { db.cashWithdrawals={}; }

const app = express();
app.set('trust proxy', 1);
// Most endpoints only need a small body, but proof-screenshot submission
// sends a base64-encoded image as JSON, so the global limit has to be
// big enough to cover that too.
// Basic application-layer hardening. This cannot make a public website
// literally impossible to DDoS; large attacks must be absorbed upstream by
// Render/Cloudflare/a WAF. These controls make the app much harder to exhaust.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use((req, res, next) => {
  const rl = rateLimit(`global:${clientIp(req)}`, cfg.GLOBAL_RATE_LIMIT, cfg.GLOBAL_RATE_WINDOW_MS);
  if (!rl.allowed) return res.status(429).json({ok:false,error:'Too many requests. Please slow down.',retryAfter:Math.ceil((rl.resetAt-Date.now())/1000)});
  next();
});
app.use(express.json({ limit: '9mb', strict: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  req.setTimeout(cfg.REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) res.status(408).json({ok:false,error:'Request timed out.'});
    req.destroy();
  });
  next();
});

const rateBuckets = new Map();
const botChallenges = new Map();
const otpAttempts = new Map();

const VIDEO_DATA_FILE = path.join(__dirname, 'data', 'videos.json');
function saveVideoConfig() {
  const adminVideos = cfg.VIDEO_TASKS.filter(v => String(v.id).startsWith('admin_video_'));
  fs.mkdirSync(path.dirname(VIDEO_DATA_FILE), { recursive:true });
  fs.writeFileSync(VIDEO_DATA_FILE, JSON.stringify(adminVideos, null, 2));
}
function normalizeVideoUrl(raw) {
  const value = String(raw || '').trim();
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.toString();
  } catch { return null; }
}
function normalizePlatform(raw, url='') {
  const p = String(raw || '').toLowerCase().trim();
  if (['youtube','tiktok','generic'].includes(p)) return p;
  if (/youtu\.be|youtube\.com/i.test(url)) return 'youtube';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  return 'generic';
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.start >= windowMs) b = { start: now, count: 0 };
  b.count++;
  rateBuckets.set(key, b);
  if (rateBuckets.size > 5000) {
    for (const [k,v] of rateBuckets) if (now - v.start >= windowMs) rateBuckets.delete(k);
  }
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.start + windowMs };
}
function audit(action, actorId, details={}) {
  db.audit = Array.isArray(db.audit) ? db.audit : [];
  db.audit.push({ id:`AUD-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`, action, actorId:Number(actorId)||0, at:new Date().toISOString(), details });
  if (db.audit.length > 5000) db.audit = db.audit.slice(-5000);
  saveAudit();
}
function requireAdmin(req,res,next) {
  if (!req.tgUser || !cfg.ADMIN_IDS.includes(Number(req.tgUser.id)) || req.tgUser.webOnly) return res.status(403).json({ok:false,error:'Admin access denied.'});
  next();
}
function issueChallenge() {
  const a = 2 + Math.floor(Math.random()*8), b = 2 + Math.floor(Math.random()*8);
  const id = crypto.randomBytes(12).toString('hex');
  botChallenges.set(id, { answer:String(a+b), expiresAt:Date.now()+10*60*1000 });
  return { id, question:`What is ${a} + ${b}?` };
}
function validChallenge(req) {
  if (!cfg.BOT_CHECK_REQUIRED || req.tgUser) return true;
  const id = String(req.get('x-bot-challenge-id') || '');
  const answer = String(req.get('x-bot-challenge-answer') || '').trim();
  const c = botChallenges.get(id);
  if (!c || c.expiresAt < Date.now() || answer !== c.answer) return false;
  c.used = true;
  return true;
}

function cleanPhone(v) { return String(v || '').replace(/[^0-9+]/g, '').slice(0, 18); }
function cleanAccount(v) { return String(v || '').replace(/\D/g, '').slice(0, 10); }
function safeText(v, max=70) { return String(v || '').trim().slice(0, max); }

let smtpTransporter = null;
function getMailer() {
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS || !cfg.SMTP_FROM) return null;
  if (!smtpTransporter) smtpTransporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465,
    auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  return smtpTransporter;
}

async function sendDailyRewardEmails() {
  if (!cfg.DAILY_REWARD_EMAIL_ENABLED) return;
  const mailer = getMailer();
  if (!mailer) return;
  const now = new Date();
  const hour = now.getUTCHours(), minute = now.getUTCMinutes();
  if (hour !== cfg.DAILY_REWARD_EMAIL_HOUR_UTC || minute !== cfg.DAILY_REWARD_EMAIL_MINUTE_UTC) return;
  const today = now.toISOString().slice(0,10);
  const markerFile = path.join(__dirname, 'data', 'daily-email.json');
  let marker = {};
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch {}
  if (marker.lastSent === today) return;
  const users = Object.values(db.users).filter(u =>
    u.verification?.email?.status === 'verified' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.verification.email.value || ''))
  );
  if (!users.length) {
    fs.writeFileSync(markerFile, JSON.stringify({lastSent:today, sent:0, at:now.toISOString()}, null, 2));
    return;
  }
  let sent = 0;
  const batchSize = Math.max(1, cfg.DAILY_REWARD_EMAIL_BATCH_SIZE);
  for (let i=0; i<users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.all(batch.map(async u => {
      try {
        await mailer.sendMail({
          from: cfg.SMTP_FROM, to: u.verification.email.value,
          subject: 'Your Xfunds daily reward is ready 🎁',
          text: `Hi ${u.firstName || 'there'},\n\nYour Xfunds daily reward is ready. Visit the Xfunds website today to claim your daily points and keep your streak going.\n\nYour current balance: ${Number(u.points || 0)} points.\n\nXfunds Rewards`,
          html: `<div style=\"font-family:Arial,sans-serif;line-height:1.6\"><h2>🎁 Your Xfunds daily reward is ready</h2><p>Hi ${safeText(u.firstName || 'there', 60)},</p><p>Your daily reward is ready. Visit Xfunds today to claim your points and keep your streak going.</p><p><b>Current balance:</b> ${Number(u.points || 0)} points</p><p>Xfunds Rewards</p></div>`
        });
        sent++;
      } catch (e) { console.warn('Daily reward email failed:', e.message); }
    }));
    if (i + batchSize < users.length) await new Promise(r => setTimeout(r, 750));
  }
  fs.writeFileSync(markerFile, JSON.stringify({lastSent:today, sent, at:now.toISOString()}, null, 2));
}
setInterval(() => sendDailyRewardEmails().catch(e => console.warn('Daily reward email job:', e.message)), 60 * 1000);


// ── Web-only sessions ──────────────────────────────────────────
// Lets someone join straight from the plain website with no Telegram
// account at all. We hand them a signed, anonymous cookie identifying
// a "web" user; everything else (points, tasks, referrals) works the
// same way it does for Telegram users. Money-moving actions (bank
// details, withdrawal) still go through the same admin review either way.
const WEB_ID_COOKIE = 'xf_wid';
const webSecret = cfg.WEB_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!cfg.WEB_SESSION_SECRET) {
  console.warn('⚠️  WEB_SESSION_SECRET is not set — web-only sessions will reset on every restart. Set it in .env for production.');
}

// The cookie holds a small signed JSON identity, not just a bare id, so a
// plain web visitor who later links their real Telegram account (via the
// Telegram Login Widget) keeps their name/username and — crucially — a
// real Telegram id that channel-membership checks can actually resolve.
function signWebIdentity(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', webSecret).update(payload).digest('hex').slice(0, 32);
  return `${payload}.${mac}`;
}
function verifyWebIdentity(cookieVal) {
  if (!cookieVal) return null;
  const idx = cookieVal.lastIndexOf('.');
  if (idx < 1) return null;
  const payload = cookieVal.slice(0, idx);
  const mac = cookieVal.slice(idx + 1);
  const expected = crypto.createHmac('sha256', webSecret).update(payload).digest('hex').slice(0, 32);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch { return null; }
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return obj && /^\d+$/.test(String(obj.id)) ? obj : null;
  } catch { return null; }
}
function setWebIdentityCookie(res, identity) {
  res.setHeader('Set-Cookie', `${WEB_ID_COOKIE}=${encodeURIComponent(signWebIdentity(identity))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
}
function parseCookies(req) {
  const header = req.get('cookie') || '';
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i === -1) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function newWebId() {
  // Kept well clear of the Telegram user-id range, and safely inside
  // Number.MAX_SAFE_INTEGER (unlike a raw "9" + full timestamp, which
  // would overflow it).
  const n = 9_000_000_000_000 + (Date.now() % 900_000_000_000) + Math.floor(Math.random() * 1000);
  return String(n);
}

function auth(req, res, next) {
  let tgUser = validateInitData(req.get('x-telegram-init-data') || '');
  if (!tgUser && cfg.DEMO_MODE) {
    const demoId = Number(req.get('x-demo-user') || 1000001);
    tgUser = { id: demoId, first_name: 'Demo', username: `demo${demoId}` };
  }
  if (!tgUser) {
    const cookies = parseCookies(req);
    let identity = verifyWebIdentity(cookies[WEB_ID_COOKIE]);
    if (!identity) {
      const rl = rateLimit(`webjoin:${clientIp(req)}`, cfg.WEB_JOIN_RATE_LIMIT, cfg.WEB_JOIN_RATE_WINDOW_MS);
      if (!rl.allowed) return res.status(429).json({ok:false,error:'Too many new web accounts from this network. Please try again later.',retryAfter:Math.ceil((rl.resetAt-Date.now())/1000)});
      identity = { id: newWebId(), first_name: 'Web user', username: '', telegramLinked: false };
      setWebIdentityCookie(res, identity);
    }
    // webOnly stays true even after linking a real Telegram account, so
    // admin access and the extra email/phone verification requirement for
    // withdrawals are unaffected — telegramLinked only unlocks a *real*
    // Telegram id so channel-membership checks can resolve it, instead of
    // failing forever for a synthetic web-only id.
    tgUser = {
      id: Number(identity.id), first_name: identity.first_name || 'Web user', username: identity.username || '',
      webOnly: true, telegramLinked: !!identity.telegramLinked
    };
  }
  req.tgUser = tgUser;
  if (!validChallenge(req)) {
    return res.status(428).json({ok:false,error:'Complete the quick bot-check first.',botCheck:true});
  }
  const ref = req.get('x-referral-code') || req.query.ref || null;
  req.user = ensureUser(tgUser, ref, { ip:clientIp(req), deviceId:req.get('x-device-id') || '', userAgent:req.get('user-agent') || '' });
  next();
}

// Lets a plain website visitor (no Telegram Mini App) prove they own a real
// Telegram account via the Telegram Login Widget. Once linked, their web
// session carries their real Telegram id, so joining the required channels
// on Telegram actually satisfies checkChannelMembership instead of the
// channel/withdrawal checks failing forever for an anonymous web id.
// Requires the deployed domain to be registered for the bot with
// @BotFather (/setdomain) — see README.
app.post('/api/auth/telegram-login', (req, res) => {
  const verified = validateLoginWidget(req.body || {});
  if (!verified) return res.status(400).json({ok:false,error:'Could not verify Telegram login. Make sure this site\'s domain is registered with @BotFather (/setdomain) and try again.'});
  const identity = { id: String(verified.id), first_name: verified.first_name || 'User', username: verified.username || '', telegramLinked: true };
  setWebIdentityCookie(res, identity);
  const tgUser = { id: Number(identity.id), first_name: identity.first_name, username: identity.username, webOnly: true, telegramLinked: true };
  const ref = req.get('x-referral-code') || req.query.ref || null;
  const user = ensureUser(tgUser, ref, { ip:clientIp(req), deviceId:req.get('x-device-id') || '', userAgent:req.get('user-agent') || '' });
  res.json({ok:true, user: publicUser(user)});
});

// Synthetic web-only ids start at 9,000,000,000,000 (see newWebId()) —
// far above any real Telegram user id — so this cheaply tells apart a
// visitor who only has an anonymous web id from one who has linked (or
// signed in as) a real Telegram account, without needing extra storage.
function authSourceTelegramLinked(u) {
  return u.authSource === 'telegram' || Number(u.id) < 9_000_000_000_000;
}

function publicUser(u, membership=null) {
  return {
    id:u.id, username:u.username, firstName:u.firstName, points:u.points,
    cashBalance:Number(u.cashBalance||0), naira:ngnFromPoints(u.points), lifetimePoints:u.lifetimePoints,
    referralCode:referralCode(u.id), referrals:u.referrals?.length || 0,
    qualifiedReferrals:u.qualifiedReferrals || 0, whatsapp:u.whatsapp,
    whatsappConnections:listConnections(u.id), bank:u.bank,
    taskClaims:u.taskClaims, videoClaims:u.videoClaims || {}, videoStarts:u.videoStarts || {}, videoWatch:u.videoWatch || {}, lastCheckIn:u.lastCheckIn, dailyClaims:u.dailyClaims || {date:null,count:0}, vip:!!u.vip,
    channelsComplete: membership ? membership.complete : null,
    checkInStreak: Number(u.checkInStreak || 0),
    rewardLog: Array.isArray(u.rewardLog) ? u.rewardLog.slice(-10).reverse() : [],
    missionClaims:u.missionClaims || {},
    authSource: u.authSource || 'telegram',
    telegramLinked: authSourceTelegramLinked(u),
    youtubeTask: { status: u.youtubeTask?.status || 'not_started', reason: u.youtubeTask?.reason || '' },
    tiktokTask: { status: u.tiktokTask?.status || 'not_started', reason: u.tiktokTask?.reason || '' },
    ...Object.fromEntries(Object.keys(social.PLATFORMS).map(id => [`${id}Task`, { status:u[`${id}Task`]?.status || 'not_started', reason:u[`${id}Task`]?.reason || '' }])),
    verification: { email:{value:u.verification?.email?.value||'',status:u.verification?.email?.status||'unverified'}, phone:{value:u.verification?.phone?.value||'',status:u.verification?.phone?.status||'unverified'} },
    abuseRisk: !!u.abuse?.referralRisk,
    vipTier: engagement.tierKey(u), vipTierLabel: engagement.tierInfo(u).label,
    level: engagement.getLevel(u.lifetimePoints), achievements: engagement.achievements(u),
    wheelClaims: u.wheelClaims || {date:null,count:0}, promoClaims: Object.keys(u.promoClaims||{})
  };
}

app.get('/api/config', (req,res) => res.json({
  ok:true, pointsPerTask:cfg.POINTS_PER_TASK, pointsPerVideo:cfg.POINTS_PER_VIDEO,
  whatsappConnectRewardPoints:cfg.WHATSAPP_CONNECT_REWARD_POINTS,
  maxWhatsappConnections:cfg.MAX_WHATSAPP_CONNECTIONS, pairingCodeTtlMs:cfg.WA_PAIRING_CODE_TTL_MS, pairingCooldownMs:cfg.WA_PAIRING_COOLDOWN_MS,
  ngnPer100Points:cfg.NGN_PER_100_POINTS,
  referralRewardPoints:cfg.REFERRAL_REWARD_POINTS, withdrawMinPoints:cfg.WITHDRAW_MIN_POINTS, dailyRewardPoints:cfg.DAILY_REWARD_POINTS, vipDailyClaims:cfg.VIP_DAILY_CLAIMS, vipWithdrawMinPoints:cfg.VIP_WITHDRAW_MIN_POINTS,
  withdrawMaxPoints:cfg.WITHDRAW_MAX_POINTS, videoWatchSeconds:cfg.VIDEO_WATCH_SECONDS,
  videos:cfg.VIDEO_TASKS.map(v=>({id:v.id,title:v.title,url:v.url,reward:v.reward,platform:v.platform||'generic',watchSeconds:Number(v.watchSeconds || cfg.VIDEO_WATCH_SECONDS)})),
  requiredChannels:cfg.REQUIRED_CHANNELS.map(c => ({ name:c, url:`https://t.me/${c.replace(/^@/,'')}` })),
  socialTasks: Object.keys(social.PLATFORMS).map(id => ({...social.getTask(id), id})),
  youtube: social.PLATFORMS.youtube ? social.getTask('youtube') : null,
  tiktok: social.PLATFORMS.tiktok ? social.getTask('tiktok') : null,
  videoHeartbeatSeconds: cfg.VIDEO_HEARTBEAT_SECONDS,
  vipTiers: engagement.VIP_TIERS, wheelRewards: engagement.WHEEL_REWARDS,
  promoEnabled: true, botUsername: cfg.BOT_USERNAME || ''
}));

app.get('/api/tasks/social/:platform', auth, (req,res) => {
  const platform = req.params.platform;
  if (!social.PLATFORMS[platform]) return res.status(404).json({ok:false,error:'Unknown task.'});
  const task = social.getTask(platform);
  if (!task.url) return res.status(400).json({ok:false,error:'This task is not configured yet.'});
  res.json({ok:true, task, state: social.getState(req.user, platform)});
});

// Web equivalent of sending a screenshot to the bot. Accepts a base64
// data URL so it works without Telegram at all.
app.post('/api/tasks/social/:platform/submit', auth, async (req,res) => {
  const rl = rateLimit(`social:${req.user.id}:${clientIp(req)}`, cfg.SOCIAL_SUBMIT_RATE_LIMIT, cfg.SOCIAL_SUBMIT_RATE_WINDOW_MS);
  if (!rl.allowed) return res.status(429).json({ok:false,error:'Too many proof submissions. Please wait before trying again.',retryAfter:Math.ceil((rl.resetAt-Date.now())/1000)});
  const platform = req.params.platform;
  if (!social.PLATFORMS[platform]) return res.status(404).json({ok:false,error:'Unknown task.'});
  const image = String(req.body?.image || '');
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
    return res.status(400).json({ok:false,error:'Send a PNG/JPEG/WEBP screenshot as a data URL.'});
  }
  if (image.length > 8 * 1024 * 1024) return res.status(400).json({ok:false,error:'Screenshot is too large.'});
  try {
    const result = await social.submitImage(req.user, image, cfg.ADMIN_ID, platform);
    res.json({ok:true, ...result});
  } catch (e) {
    res.status(400).json({ok:false,error:e.message?.slice(0,300) || 'Could not process the screenshot.'});
  }
});

app.get('/api/earn', auth, async (req,res) => {
  const u = req.user;
  let membership = {complete:false};
  try { membership = await checkChannelMembership(u.id); } catch {}
  const today = new Date().toISOString().slice(0,10);
  const videos = cfg.VIDEO_TASKS.map(v => ({
    id:v.id,title:v.title,reward:v.reward,platform:v.platform || 'generic',completed:!!u.videoClaims?.[v.id],available:!u.videoClaims?.[v.id]
  }));
  const activeWa = (u.whatsappConnections||[]).filter(x => ['pairing','connected'].includes(x.status)).length;
  const dailyCount = u.dailyClaims?.date === today ? Number(u.dailyClaims.count || 0) : 0;
  const dailyLimit = engagement.tierInfo(u).dailyClaims;
  const dailyAvailable = dailyCount < dailyLimit;
  const socialItems = Object.keys(social.PLATFORMS).map(id => {
    const task = social.getTask(id), state = social.getState(u,id);
    const icon = task.platform === 'youtube' ? '▶️' : '🎵';
    return {id,icon,title:task.title,reward:task.reward,available:!!task.url && state.status!=='approved',completed:state.status==='approved',platform:task.platform,url:task.url,accountName:task.accountName};
  });
  const items = [
    {id:'channels',icon:'📣',title:'Join required channels',reward:cfg.POINTS_PER_TASK,available:!membership.complete && !u.taskClaims?.channels,completed:!!u.taskClaims?.channels},
    ...socialItems,
    {id:'videos',icon:'🎬',title:'Watch videos',reward:videos.filter(v=>v.available).reduce((n,v)=>n+Number(v.reward||0),0),available:videos.some(v=>v.available),completed:videos.length>0 && videos.every(v=>v.completed)},
    {id:'whatsapp',icon:'📱',title:'Connect WhatsApp',reward:Math.max(0,cfg.MAX_WHATSAPP_CONNECTIONS-activeWa)*cfg.WHATSAPP_CONNECT_REWARD_POINTS,available:activeWa<cfg.MAX_WHATSAPP_CONNECTIONS,completed:activeWa>=cfg.MAX_WHATSAPP_CONNECTIONS},
    {id:'daily',icon:'🔥',title:u.vip ? `VIP daily claim (${dailyCount}/${dailyLimit})` : 'Daily check-in',reward:cfg.DAILY_REWARD_POINTS,available:dailyAvailable,completed:!dailyAvailable},
    {id:'referrals',icon:'🤝',title:'Qualified referrals',reward:cfg.REFERRAL_REWARD_POINTS,available:true,completed:false}
  ];
  const availablePoints = items.reduce((n,x)=>n+Number(x.available?x.reward:0),0);
  const missions = missionStatus(u);
  const missionPoints = missions.filter(m=>m.claimable).reduce((n,m)=>n+Number(m.reward||0),0);
  res.json({ok:true,availablePoints:availablePoints+missionPoints,items,videos,missions,missionPoints,streak:Number(u.checkInStreak||0),qualifiedReferrals:Number(u.qualifiedReferrals||0)});
});

app.get('/api/missions', auth, (req,res) => {
  res.json({ok:true,missions:missionStatus(req.user)});
});

app.post('/api/missions/:id/claim', auth, (req,res) => {
  const mission = missionStatus(req.user).find(x => x.id === req.params.id);
  if (!mission) return res.status(404).json({ok:false,error:'Mission not found.'});
  if (!mission.claimable) return res.status(400).json({ok:false,error:'Mission is not ready to claim yet.',mission});
  const rewarded = claimMission(req.user, mission.id, mission.reward);
  res.json({ok:true,rewarded,points:req.user.points,mission:missionStatus(req.user).find(x=>x.id===mission.id)});
});

app.get('/api/leaderboard', auth, (req,res) => {
  const limit = Math.min(20, Math.max(5, Number(req.query.limit || 10))); const period=String(req.query.period||'all').toLowerCase();
  const cutoff=period==='weekly'?Date.now()-7*86400000:period==='monthly'?Date.now()-30*86400000:0;
  const rows=Object.values(db.users).map(u=>{const points=cutoff?((u.rewardLog||[]).filter(x=>new Date(x.at).getTime()>=cutoff).reduce((n,x)=>n+Number(x.amount||0),0)):Number(u.lifetimePoints||0);return {u,points};}).sort((a,b)=>b.points-a.points).slice(0,limit).map((x,i)=>({rank:i+1,id:x.u.id,name:x.u.firstName||x.u.username||`User ${x.u.id}`,username:x.u.username||'',points:x.points,level:engagement.getLevel(x.u.lifetimePoints)}));
  const all=Object.values(db.users).map(u=>({id:u.id,points:cutoff?((u.rewardLog||[]).filter(x=>new Date(x.at).getTime()>=cutoff).reduce((n,x)=>n+Number(x.amount||0),0)):Number(u.lifetimePoints||0)})).sort((a,b)=>b.points-a.points); const myRank=all.findIndex(x=>String(x.id)===String(req.user.id))+1;
  res.json({ok:true,period,leaderboard:rows,myRank});
});

app.get('/api/history', auth, (req,res) => {
  res.json({ok:true,history:Array.isArray(req.user.rewardLog) ? req.user.rewardLog.slice(-30).reverse() : []});
});

app.get('/api/rewards-center', auth, (req,res) => {
  const u=req.user, today=new Date().toISOString().slice(0,10);
  res.json({ok:true, cashBalance:Number(u.cashBalance||0),points:Number(u.points||0),streak:Number(u.checkInStreak||0),wheel:{count:u.wheelClaims?.date===today?Number(u.wheelClaims.count||0):0,limit:u.vip?2:1,rewards:engagement.WHEEL_REWARDS},scratchAvailable:u.scratchClaims?.date!==today,mysteryAvailable:u.mysteryClaims?.date!==today,streakBonusAvailable:false});
});

app.get('/api/advanced', auth, (req,res) => {
  res.json({ok:true,...advanced.status(req.user), level:engagement.getLevel(req.user.lifetimePoints), vipTier:engagement.tierKey(req.user)});
});
app.post('/api/games/coinflip', auth, (req,res) => { const r=advanced.playCoin(req.user,String(req.body?.choice||'')); if(!r.ok)return res.status(400).json(r); audit('game_coinflip',req.user.id,{result:r.result,won:r.won,reward:r.reward}); res.json({...r,points:req.user.points}); });
app.post('/api/games/dice', auth, (req,res) => { const r=advanced.playDice(req.user,req.body?.guess); if(!r.ok)return res.status(400).json(r); audit('game_dice',req.user.id,{result:r.result,won:r.won,reward:r.reward}); res.json({...r,points:req.user.points}); });
app.post('/api/games/guess', auth, (req,res) => { const r=advanced.playGuess(req.user,req.body?.guess); if(!r.ok)return res.status(400).json(r); audit('game_guess',req.user.id,{result:r.result,won:r.won,reward:r.reward}); res.json({...r,points:req.user.points}); });
app.get('/api/referrals', auth, (req,res) => {
  const stats = referralStats(req.user);
  const base = `${cfg.APP_URL}/r/${encodeURIComponent(stats.code)}`;
  res.json({ok:true,...stats,referralLink:base});
});

app.post('/api/referrals/milestone/:n/claim', auth, (req,res) => { const r=advanced.claimReferralMilestone(req.user,req.params.n); if(!r.ok)return res.status(400).json(r); audit('referral_milestone',req.user.id,{milestone:r.milestone,reward:r.reward}); res.json({...r,points:req.user.points}); });

app.post('/api/rewards/scratch', auth, (req,res)=>{ const r=scratchCard(req.user); if(!r.ok)return res.status(400).json(r); audit('scratch_card',req.user.id,{reward:r.reward}); res.json({...r,points:req.user.points,cashBalance:req.user.cashBalance}); });
app.post('/api/rewards/mystery', auth, (req,res)=>{ const r=mysteryBox(req.user); if(!r.ok)return res.status(400).json(r); audit('mystery_box',req.user.id,{reward:r.reward}); res.json({...r,points:req.user.points,cashBalance:req.user.cashBalance}); });
app.post('/api/rewards/streak-bonus', auth, (req,res)=>{ const r=streakBonus(req.user); if(!r.ok)return res.status(400).json(r); audit('streak_bonus',req.user.id,{milestone:r.milestone,reward:r.reward}); res.json({...r,points:req.user.points}); });

app.get('/api/me', auth, async (req,res) => {
  let membership = null;
  try { membership = await checkChannelMembership(req.user.id); } catch {}
  res.json({ ok:true, user:publicUser(req.user,membership) });
});

app.post('/api/tasks/channels/verify', auth, async (req,res) => {
  if (!authSourceTelegramLinked(req.user)) return res.status(400).json({ok:false,error:'Link your Telegram account first — this website can only confirm you joined the channels once it knows your real Telegram account.', needsTelegramLink:true});
  const check = await checkChannelMembership(req.user.id);
  if (check.configurationError) return res.status(500).json({ok:false,error:'Required channels are not configured.'});
  if (!check.complete) return res.status(400).json({ok:false,error:'Join all required channels first.', channels:check.channels});
  const rewarded = award(req.user, cfg.POINTS_PER_TASK, 'channels');
  maybeQualifyReferral(req.user);
  res.json({ok:true,rewarded,points:req.user.points,channels:check.channels});
});

app.post('/api/tasks/whatsapp/link', auth, (req,res) => {
  const number = cleanPhone(req.body.number);
  if (!/^\+?[0-9]{8,15}$/.test(number)) return res.status(400).json({ok:false,error:'Enter a valid WhatsApp phone number.'});
  req.user.whatsapp = { number, status:'pending' };
  saveUsers();
  res.json({ok:true,status:'pending',message:'WhatsApp number submitted for admin verification.'});
});

app.post('/api/tasks/video/start', auth, (req,res) => {
  const video = cfg.VIDEO_TASKS.find(v=>v.id===String(req.body.videoId));
  if (!video) return res.status(404).json({ok:false,error:'Video task not found.'});
  req.user.videoStarts = req.user.videoStarts || {};
  req.user.videoWatch = req.user.videoWatch || {};
  req.user.videoHeartbeatAt = req.user.videoHeartbeatAt || {};
  req.user.videoStarts[video.id] = Date.now();
  req.user.videoWatch[video.id] = 0;
  req.user.videoHeartbeatAt[video.id] = Date.now();
  saveUsers();
  res.json({ok:true,videoId:video.id,watchSeconds:Number(video.watchSeconds || cfg.VIDEO_WATCH_SECONDS),startedAt:req.user.videoStarts[video.id]});
});

// The player page pings this every few seconds — but only while the tab
// is actually visible and focused (see public/videos.js). Time only
// accrues from these pings, each one capped, so leaving the task open
// in a background tab no longer counts as "watching".
app.post('/api/tasks/video/heartbeat', auth, (req,res) => {
  const video = cfg.VIDEO_TASKS.find(v=>v.id===String(req.body.videoId));
  if (!video) return res.status(404).json({ok:false,error:'Video task not found.'});
  const u = req.user;
  if (u.videoClaims?.[video.id]) { const requiredSeconds=Number(video.watchSeconds || cfg.VIDEO_WATCH_SECONDS); return res.json({ok:true,watched:requiredSeconds,required:requiredSeconds}); }
  const startedAt = Number(u.videoStarts?.[video.id] || 0);
  if (!startedAt) return res.status(400).json({ok:false,error:'Start the video task first.'});
  u.videoWatch = u.videoWatch || {};
  u.videoHeartbeatAt = u.videoHeartbeatAt || {};
  const now = Date.now();
  const last = Number(u.videoHeartbeatAt[video.id] || startedAt);
  const cap = cfg.VIDEO_HEARTBEAT_SECONDS + 2; // small slack for network jitter
  const deltaSeconds = Math.max(0, Math.min(cap, (now - last) / 1000));
  const requiredSeconds = Number(video.watchSeconds || cfg.VIDEO_WATCH_SECONDS);
  u.videoWatch[video.id] = Math.min(requiredSeconds, Number(u.videoWatch[video.id] || 0) + deltaSeconds);
  u.videoHeartbeatAt[video.id] = now;
  saveUsers();
  res.json({ok:true, watched: Math.round(u.videoWatch[video.id]), required: Number(video.watchSeconds || cfg.VIDEO_WATCH_SECONDS)});
});

app.post('/api/tasks/video/claim', auth, (req,res) => {
  const video = cfg.VIDEO_TASKS.find(v=>v.id===String(req.body.videoId));
  if (!video) return res.status(404).json({ok:false,error:'Video task not found.'});
  if (req.user.videoClaims?.[video.id]) return res.json({ok:true,rewarded:false,points:req.user.points,videoId:video.id});
  const watched = Number(req.user.videoWatch?.[video.id] || 0);
  const requiredSeconds = Number(video.watchSeconds || cfg.VIDEO_WATCH_SECONDS);
  if (watched < requiredSeconds) return res.status(400).json({ok:false,error:`Keep watching — ${Math.ceil(requiredSeconds-watched)} more second(s) of active viewing needed before you can claim.`});
  const rewarded = claimVideo(req.user, video.id, video.reward);
  res.json({ok:true,rewarded,points:req.user.points,videoId:video.id});
});

app.post('/api/tasks/checkin', auth, (req,res) => {
  const rewarded = claimDaily(req.user);
  const today = new Date().toISOString().slice(0,10);
  const count = req.user.dailyClaims?.date === today ? Number(req.user.dailyClaims.count || 0) : 0;
  const limit = engagement.tierInfo(req.user).dailyClaims;
  res.json({ok:true,rewarded,points:req.user.points,lastCheckIn:req.user.lastCheckIn,dailyCount:count,dailyLimit:limit,vip:!!req.user.vip});
});

app.get('/api/whatsapp/connections', auth, (req,res) => {
  res.json({ok:true,connections:listConnections(req.user.id),max:cfg.MAX_WHATSAPP_CONNECTIONS,reward:cfg.WHATSAPP_CONNECT_REWARD_POINTS});
});

app.post('/api/whatsapp/pair', auth, async (req,res) => {
  try {
    const mode=String(req.body?.mode||'code').toLowerCase()==='qr'?'qr':'code';
    const result=await startPairing(req.user.id,cleanPhone(req.body?.number),mode);
    res.json({ok:true,...result});
  } catch(e) { res.status(400).json({ok:false,error:e.message}); }
});
app.get('/api/whatsapp/pair/:connectionId', auth, (req,res) => {
  const state=getPairingState(req.user.id,req.params.connectionId);
  if(!state)return res.status(404).json({ok:false,error:'Connection not found.'});
  res.json({ok:true,...state});
});

app.post('/api/whatsapp/pair/:connectionId/refresh', auth, async (req,res) => {
  try {
    const result=await refreshPairingCode(req.user.id,String(req.params.connectionId));
    res.json({ok:true,...result});
  } catch(e) { res.status(400).json({ok:false,error:e.message}); }
});

app.post('/api/whatsapp/disconnect', auth, async (req,res) => {
  try { await disconnect(req.user.id, String(req.body.connectionId)); res.json({ok:true}); }
  catch(e){ res.status(400).json({ok:false,error:e.message}); }
});

app.post('/api/bank', auth, (req,res) => {
  const bankName = safeText(req.body.bankName, 50);
  const accountNumber = cleanAccount(req.body.accountNumber);
  const accountName = safeText(req.body.accountName, 70);
  if (!bankName || accountNumber.length !== 10 || !accountName) return res.status(400).json({ok:false,error:'Enter bank name, a 10-digit account number, and account name.'});
  req.user.bank = { bankName, accountNumber, accountName, status:'pending', reviewedAt:null };
  saveUsers();
  if (cfg.ADMIN_ID && cfg.BOT_TOKEN) {
    telegramApi('sendMessage', { chat_id:cfg.ADMIN_ID, text:`🏦 Bank verification requested\n\nUser: ${req.user.username ? '@'+req.user.username : req.user.id}\nBank: ${bankName}\nAccount: ${accountNumber}\nName: ${accountName}`, reply_markup:{inline_keyboard:[[{text:'✅ Verify bank',callback_data:`bank_ok:${req.user.id}`},{text:'❌ Reject',callback_data:`bank_no:${req.user.id}`}]]} }).catch(()=>{});
  }
  res.json({ok:true,status:'pending'});
});

app.post('/api/cash-withdraw', auth, (req,res) => {
  const u=req.user; const amount=Math.floor(Number(req.body?.amount||0)*100)/100;
  if(db.system?.withdrawalsFrozen) return res.status(400).json({ok:false,error:'Withdrawals are temporarily frozen.'});
  if(!Number.isFinite(amount)||amount<cfg.CASH_WITHDRAW_MIN_NGN||amount>cfg.CASH_WITHDRAW_MAX_NGN) return res.status(400).json({ok:false,error:`Cash withdrawal must be between ₦${cfg.CASH_WITHDRAW_MIN_NGN} and ₦${cfg.CASH_WITHDRAW_MAX_NGN}.`});
  if(Number(u.cashBalance||0)<amount) return res.status(400).json({ok:false,error:'Insufficient cash balance.'});
  if(u.bank?.status!=='verified') return res.status(400).json({ok:false,error:'Verify your bank account first.'});
  const id=`CWD-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  db.cashWithdrawals=db.cashWithdrawals||{}; db.cashWithdrawals[id]={id,userId:u.id,amount,status:'pending',bank:{...u.bank},createdAt:new Date().toISOString()};
  u.cashBalance=Number(u.cashBalance)-amount; saveUsers();
  // Persist alongside the normal database without introducing another store API.
  const fp=path.join(__dirname,'data','cash-withdrawals.json'); fs.writeFileSync(fp,JSON.stringify(db.cashWithdrawals,null,2));
  audit('cash_withdrawal_requested',u.id,{id,amount}); res.json({ok:true,id,amount,cashBalance:u.cashBalance});
});

app.post('/api/withdraw', auth, async (req,res) => {
  if(db.system?.withdrawalsFrozen) return res.status(503).json({ok:false,error:'Withdrawals are temporarily paused by the admin.'});
  const u=req.user;
  const vip=!!u.vip;
  const points=Math.floor(Number(req.body.points));
  const min=vip ? engagement.tierInfo(u).withdrawMin : cfg.WITHDRAW_MIN_POINTS;
  if(!Number.isFinite(points)||points<min||points>cfg.WITHDRAW_MAX_POINTS||points>u.points) return res.status(400).json({ok:false,error:vip?`VIP withdrawals start at ${min.toLocaleString()} points.`:`Normal users can withdraw only after reaching ${cfg.WITHDRAW_MIN_POINTS.toLocaleString()} points.`});
  if(!vip && points !== cfg.WITHDRAW_MIN_POINTS) return res.status(400).json({ok:false,error:`Normal withdrawals must be exactly ${cfg.WITHDRAW_MIN_POINTS.toLocaleString()} points.`});
  if(u.bank?.status!=='verified') return res.status(400).json({ok:false,error:'Verify your bank account before requesting payment.'});
  if(cfg.EMAIL_VERIFICATION_REQUIRED && u.authSource==='web' && u.verification?.email?.status!=='verified') return res.status(400).json({ok:false,error:'Verify your email before requesting payment.'});
  if(cfg.PHONE_VERIFICATION_REQUIRED && u.authSource==='web' && u.verification?.phone?.status!=='verified') return res.status(400).json({ok:false,error:'Verify your phone before requesting payment.'});
  if (!authSourceTelegramLinked(u)) return res.status(400).json({ok:false,error:'Link your Telegram account first so we can confirm your channel membership before payment.', needsTelegramLink:true});
  let membership={complete:true}; try { membership=await checkChannelMembership(u.id); } catch {}
  if(!membership.complete) return res.status(400).json({ok:false,error:'Rejoin all required channels before payment.'});
  const id=`WD-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  u.points-=points;
  db.withdrawals[id]={id,userId:u.id,username:u.username,points,naira:ngnFromPoints(points),bank:{...u.bank},vip,resetAfterPaid:!vip,status:'pending',createdAt:new Date().toISOString()};
  saveUsers(); saveWithdrawals(); audit('withdrawal_requested',u.id,{id,points,vip,resetAfterPaid:!vip});
  if(cfg.ADMIN_ID) telegramApi('sendMessage',{chat_id:cfg.ADMIN_ID,text:`💸 Xfunds withdrawal request\n\nID: ${id}\nUser: ${u.username?'@'+u.username:u.id}\nType: ${vip?'⭐ VIP':'NORMAL'}\nPoints: ${points.toLocaleString()}\nValue: ₦${ngnFromPoints(points).toFixed(2)}\nBank: ${u.bank.bankName}\nAccount: ${u.bank.accountNumber}\nName: ${u.bank.accountName}`,reply_markup:{inline_keyboard:[[{text:'✅ Paid',callback_data:`wd_ok:${id}`},{text:'↩️ Reject + refund',callback_data:`wd_no:${id}`}]]}}).catch(()=>{});
  res.json({ok:true,id,pointsRemaining:u.points,status:'pending',vip,resetAfterPaid:!vip});
});

app.get('/api/engagement', auth, (req,res) => {
  engagement.syncAchievements(req.user);
  const level=engagement.getLevel(req.user.lifetimePoints);
  const a=engagement.achievements(req.user);
  const today=new Date().toISOString().slice(0,10);
  const wheel=req.user.wheelClaims?.date===today ? req.user.wheelClaims : {date:today,count:0};
  res.json({ok:true,level,achievements:a,vipTier:engagement.tierKey(req.user),vipTierInfo:engagement.tierInfo(req.user),wheel:{rewards:engagement.WHEEL_REWARDS,spinCount:wheel.count,spinLimit:req.user.vip?2:1}});
});

app.post('/api/wheel/spin', auth, (req,res) => { const result=engagement.spinWheel(req.user); if(!result.ok) return res.status(400).json(result); audit('wheel_spin',req.user.id,{reward:result.reward}); res.json({...result,points:req.user.points}); });

app.post('/api/promo/redeem', auth, (req,res) => { const result=engagement.redeemPromo(req.user,req.body?.code); if(!result.ok) return res.status(400).json(result); audit('promo_redeemed',req.user.id,{code:result.code,reward:result.reward}); res.json({...result,points:req.user.points}); });

app.post('/api/vip/request', auth, (req,res) => {
  const u=req.user;
  if(u.vip) return res.json({ok:true,vip:true,message:'You are already a VIP user.'});
  const owner=cfg.VIP_OWNER_USERNAME ? `@${cfg.VIP_OWNER_USERNAME}` : 'the Xfunds owner';
  const linked = authSourceTelegramLinked(u);
  if(cfg.ADMIN_ID && cfg.BOT_TOKEN) telegramApi('sendMessage',{chat_id:cfg.ADMIN_ID,text:`⭐ VIP ACCESS REQUEST\n\nUser ID: ${u.id}\nUsername: ${u.username?'@'+u.username:'—'}\nName: ${u.firstName||'User'}\nSource: ${linked?'Telegram':'Website (no linked Telegram account)'}\n\nThe user is requesting VIP access.`,reply_markup:{inline_keyboard:[[{text:'⭐ Grant VIP',callback_data:`vip_ok:${u.id}`},{text:'❌ Reject',callback_data:`vip_no:${u.id}`}]]}}).catch(()=>{});
  // A plain web visitor with no linked Telegram account has no real
  // Telegram ID to DM the owner with — telling them to DM one is a dead
  // end. Their request still reaches the admin either way; only the
  // "speed it up yourself" instruction differs.
  const message = linked
    ? `Request sent. To speed this up, DM ${owner} with your Telegram ID: ${u.id}`
    : `Request sent to the admin for review. Link your Telegram account above for faster approval, or wait for the admin to review your request.`;
  res.json({ok:true,vip:false,owner,telegramId:linked?u.id:null,message});
});

app.post('/api/verify/email/request', auth, async (req,res) => {
  const email = normalizeEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ok:false,error:'Enter a valid email address.'});
  const rl = rateLimit(`email:${req.user.id}`, 3, 60*60*1000);
  if (!rl.allowed) return res.status(429).json({ok:false,error:'Too many verification codes. Try again later.'});
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS || !cfg.SMTP_FROM) return res.status(503).json({ok:false,error:'Email verification is enabled but SMTP is not configured.'});
  const code=makeOtp();
  req.user.verification.email={value:email,status:'pending',codeHash:otpHash(code),expiresAt:Date.now()+10*60*1000,verifiedAt:null};
  saveUsers();
  try {
    const transporter=getMailer();
    await transporter.sendMail({from:cfg.SMTP_FROM,to:email,subject:'Xfunds verification code',text:`Your Xfunds verification code is ${code}. It expires in 10 minutes.`});
    res.json({ok:true,message:'Verification code sent.'});
  } catch(e) { req.user.verification.email.status='unverified'; req.user.verification.email.codeHash=null; saveUsers(); res.status(502).json({ok:false,error:'Could not send verification email.'}); }
});

app.post('/api/verify/email/confirm', auth, (req,res) => {
  const code=String(req.body.code||'').trim(), v=req.user.verification?.email;
  if (!v?.codeHash || v.expiresAt<Date.now() || otpHash(code)!==v.codeHash) return res.status(400).json({ok:false,error:'Invalid or expired email code.'});
  v.status='verified'; v.verifiedAt=new Date().toISOString(); v.codeHash=null; v.expiresAt=null; saveUsers(); audit('email_verified',req.user.id,{email:v.value}); res.json({ok:true});
});

app.post('/api/verify/phone/request', auth, async (req,res) => {
  const phone=cleanPhone(req.body.phone);
  if (!/^\+?[0-9]{8,15}$/.test(phone)) return res.status(400).json({ok:false,error:'Enter a valid phone number.'});
  const rl=rateLimit(`phone:${req.user.id}`,3,60*60*1000);
  if (!rl.allowed) return res.status(429).json({ok:false,error:'Too many verification codes. Try again later.'});
  if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.TWILIO_FROM) return res.status(503).json({ok:false,error:'Phone verification is enabled but Twilio is not configured.'});
  const code=makeOtp();
  req.user.verification.phone={value:phone,status:'pending',codeHash:otpHash(code),expiresAt:Date.now()+10*60*1000,verifiedAt:null};
  saveUsers();
  try {
    const twilio=require('twilio')(cfg.TWILIO_ACCOUNT_SID,cfg.TWILIO_AUTH_TOKEN);
    await twilio.messages.create({body:`Xfunds verification code: ${code}. Expires in 10 minutes.`,from:cfg.TWILIO_FROM,to:phone});
    res.json({ok:true,message:'Verification code sent.'});
  } catch(e) { req.user.verification.phone.status='unverified'; req.user.verification.phone.codeHash=null; saveUsers(); res.status(502).json({ok:false,error:'Could not send verification SMS.'}); }
});

app.post('/api/verify/phone/confirm', auth, (req,res) => {
  const code=String(req.body.code||'').trim(), v=req.user.verification?.phone;
  if (!v?.codeHash || v.expiresAt<Date.now() || otpHash(code)!==v.codeHash) return res.status(400).json({ok:false,error:'Invalid or expired phone code.'});
  v.status='verified'; v.verifiedAt=new Date().toISOString(); v.codeHash=null; v.expiresAt=null; saveUsers(); audit('phone_verified',req.user.id,{phone:v.value}); res.json({ok:true});
});


app.post('/api/admin/users/:id/vip', auth, requireAdmin, (req,res) => {
  const target=db.users[String(req.params.id)]; if(!target) return res.status(404).json({ok:false,error:'User not found.'});
  target.vip=!!req.body.vip; target.vipTier=target.vip ? (target.vipTier && target.vipTier!=='normal' ? target.vipTier : 'silver') : 'normal'; saveUsers(); audit(target.vip?'vip_granted':'vip_removed',req.tgUser.id,{userId:target.id});
  if(cfg.BOT_TOKEN) telegramApi('sendMessage',{chat_id:target.id,text:target.vip?`⭐ VIP ACCESS GRANTED\n\nTier: ${engagement.tierInfo(target).label}\nYou can now claim daily rewards multiple times and request withdrawals from ${engagement.tierInfo(target).withdrawMin} points.`:`VIP access has been removed.`}).catch(()=>{});
  res.json({ok:true,vip:target.vip});
});

app.get('/api/admin/advanced', auth, requireAdmin, (req,res) => { res.json({ok:true,stats:advanced.adminStats(),campaigns:advanced.state.campaigns}); });
app.post('/api/admin/campaigns', auth, requireAdmin, (req,res) => { try { const c=advanced.createCampaign(req.body||{}); audit('boost_campaign_created',req.tgUser.id,{id:c.id,title:c.title,multiplier:c.multiplier}); res.json({ok:true,campaign:c}); } catch(e){res.status(400).json({ok:false,error:e.message});} });
app.delete('/api/admin/campaigns/:id', auth, requireAdmin, (req,res) => { if(!advanced.disableCampaign(String(req.params.id)))return res.status(404).json({ok:false,error:'Campaign not found.'}); audit('boost_campaign_disabled',req.tgUser.id,{id:req.params.id}); res.json({ok:true}); });

app.get('/api/admin/videos', auth, requireAdmin, (req,res) => {
  res.json({ok:true,videos:cfg.VIDEO_TASKS.map(v => ({id:v.id,title:v.title,url:v.url,reward:Number(v.reward||0),platform:v.platform||'generic',watchSeconds:Number(v.watchSeconds || cfg.VIDEO_WATCH_SECONDS),editable:String(v.id).startsWith('admin_video_')}))});
});

app.post('/api/admin/videos', auth, requireAdmin, (req,res) => {
  const title = safeText(req.body.title, 120);
  const url = normalizeVideoUrl(req.body.url);
  const platform = normalizePlatform(req.body.platform, url || '');
  const reward = Number(req.body.reward);
  const watchSeconds = Number(req.body.watchSeconds);
  if (!title) return res.status(400).json({ok:false,error:'Video title is required.'});
  if (!url) return res.status(400).json({ok:false,error:'Enter a valid http(s) video URL.'});
  if (!Number.isFinite(reward) || reward < 1 || reward > 100000) return res.status(400).json({ok:false,error:'Reward must be between 1 and 100,000 points.'});
  if (!Number.isFinite(watchSeconds) || watchSeconds < 5 || watchSeconds > 3600) return res.status(400).json({ok:false,error:'Watch time must be between 5 seconds and 1 hour.'});
  const video = {id:`admin_video_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,title,url,platform,reward:Math.round(reward),watchSeconds:Math.round(watchSeconds),createdAt:new Date().toISOString()};
  cfg.VIDEO_TASKS.push(video);
  saveVideoConfig();
  audit('video_added', req.tgUser.id, {videoId:video.id,title:video.title,url:video.url,platform:video.platform,reward:video.reward,watchSeconds:video.watchSeconds});
  res.json({ok:true,video});
});

app.delete('/api/admin/videos/:id', auth, requireAdmin, (req,res) => {
  const id = String(req.params.id);
  if (!id.startsWith('admin_video_')) return res.status(400).json({ok:false,error:'Only admin-created videos can be removed here.'});
  const index = cfg.VIDEO_TASKS.findIndex(v => String(v.id) === id);
  if (index < 0) return res.status(404).json({ok:false,error:'Video not found.'});
  const [removed] = cfg.VIDEO_TASKS.splice(index, 1);
  saveVideoConfig();
  audit('video_removed', req.tgUser.id, {videoId:removed.id,title:removed.title});
  res.json({ok:true,removed:removed.id});
});

app.get('/api/admin/promos', auth, requireAdmin, (req,res) => res.json({ok:true,promos:Object.values(db.promos||{}).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))}));
app.post('/api/admin/promos', auth, requireAdmin, (req,res) => {
  const code=safeText(req.body?.code,40).toUpperCase().replace(/[^A-Z0-9_-]/g,''); const reward=Math.floor(Number(req.body?.reward));
  if(!code||!Number.isFinite(reward)||reward<=0) return res.status(400).json({ok:false,error:'Enter a valid promo code and reward.'});
  db.promos=db.promos||{}; if(db.promos[code]) return res.status(400).json({ok:false,error:'Promo code already exists.'});
  db.promos[code]={code,reward,rewardType:req.body?.rewardType==='cash'?'cash':'points',maxUses:Math.max(0,Math.floor(Number(req.body?.maxUses||0))),used:0,vipOnly:!!req.body?.vipOnly,expiresAt:req.body?.expiresAt||null,active:true,createdAt:new Date().toISOString(),createdBy:req.tgUser.id}; savePromos(); audit('promo_created',req.tgUser.id,{code,reward}); res.json({ok:true,promo:db.promos[code]});
});
app.delete('/api/admin/promos/:code', auth, requireAdmin, (req,res) => { const code=String(req.params.code).toUpperCase(); if(!db.promos?.[code]) return res.status(404).json({ok:false,error:'Promo not found.'}); db.promos[code].active=false; savePromos(); audit('promo_disabled',req.tgUser.id,{code}); res.json({ok:true}); });
app.post('/api/admin/users/:id/vip-tier', auth, requireAdmin, (req,res) => { const u=db.users[String(req.params.id)]; const tier=String(req.body?.tier||'normal').toLowerCase(); if(!u||!engagement.VIP_TIERS[tier]) return res.status(400).json({ok:false,error:'User or VIP tier not found.'}); u.vip=tier!=='normal'; u.vipTier=tier; saveUsers(); audit('vip_tier_changed',req.tgUser.id,{userId:u.id,tier}); res.json({ok:true,vip:u.vip,vipTier:tier}); });
app.get('/api/admin/analytics', auth, requireAdmin, (req,res) => { const users=Object.values(db.users); const withdrawals=Object.values(db.withdrawals||{}); const proofs=Object.values(db.users).flatMap(u=>[u.youtubeTask?.status==='pending'?1:0,u.tiktokTask?.status==='pending'?1:0]).reduce((a,b)=>a+b,0); res.json({ok:true,analytics:{totalUsers:users.length,activeToday:users.filter(u=>String(u.lastCheckIn||'')===new Date().toISOString().slice(0,10)).length,newUsers7d:users.filter(u=>Date.now()-new Date(u.createdAt||0).getTime()<7*86400000).length,pointsIssued:users.reduce((n,u)=>n+Number(u.lifetimePoints||0),0),pointsBalances:users.reduce((n,u)=>n+Number(u.points||0),0),withdrawnPoints:withdrawals.filter(w=>w.status==='paid').reduce((n,w)=>n+Number(w.points||0),0),videosCompleted:users.reduce((n,u)=>n+Object.keys(u.videoClaims||{}).length,0),qualifiedReferrals:users.reduce((n,u)=>n+Number(u.qualifiedReferrals||0),0),vipUsers:users.filter(u=>u.vip).length,fraudFlags:users.filter(u=>u.abuse?.referralRisk).length,pendingSocialProof:proofs,pendingWithdrawals:withdrawals.filter(w=>w.status==='pending').length}}); });
app.post('/api/admin/users/:id/status', auth, requireAdmin, (req,res) => { const u=db.users[String(req.params.id)]; const status=['active','frozen','banned'].includes(String(req.body?.status))?String(req.body.status):'active'; if(!u)return res.status(404).json({ok:false,error:'User not found.'}); u.accountStatus=status; saveUsers(); audit('user_status_changed',req.tgUser.id,{userId:u.id,status}); res.json({ok:true,status}); });
app.post('/api/admin/system/withdrawals', auth, requireAdmin, (req,res) => { db.system.withdrawalsFrozen=!!req.body?.frozen; saveSystem(); audit('withdrawals_freeze_changed',req.tgUser.id,{frozen:db.system.withdrawalsFrozen}); res.json({ok:true,frozen:db.system.withdrawalsFrozen}); });
app.get('/api/admin/system', auth, requireAdmin, (req,res) => res.json({ok:true,withdrawalsFrozen:!!db.system?.withdrawalsFrozen}));
app.get('/api/admin/summary', auth, requireAdmin, (req,res) => {
  const users=Object.values(db.users);
  res.json({ok:true,stats:{users:users.length,pendingWithdrawals:Object.values(db.withdrawals).filter(x=>x.status==='pending').length,pendingProofs:users.reduce((n,u)=>n+['youtubeTask','tiktokTask'].reduce((m,k)=>m+(u[k]?.status==='pending'?1:0),0),0),riskFlags:users.filter(u=>u.abuse?.referralRisk).length,pendingBanks:users.filter(u=>u.bank?.status==='pending').length}});
});
app.get('/api/admin/whatsapp', auth, requireAdmin, (req,res) => {
  const connections=[];
  for(const u of Object.values(db.users)) for(const c of (u.whatsappConnections||[])) connections.push({
    userId:u.id,username:u.username||'',firstName:u.firstName||'',id:c.id,number:c.number,status:c.status,
    method:c.method||'code',createdAt:c.createdAt,connectedAt:c.connectedAt,rewarded:!!c.rewarded,
    autoJoin:c.autoJoin||{joined:[],failed:[]}
  });
  res.json({ok:true,connections});
});

app.get('/api/admin/users', auth, requireAdmin, (req,res) => {
  const q=String(req.query.q||'').trim().toLowerCase();
  const rows=Object.values(db.users).filter(u=>!q||String(u.id)===q||String(u.username||'').toLowerCase().includes(q)||String(u.firstName||'').toLowerCase().includes(q)).slice(0,100)
    .map(u=>({id:u.id,username:u.username,firstName:u.firstName,points:u.points,lifetimePoints:u.lifetimePoints,referrals:u.qualifiedReferrals||0,referralRisk:!!u.abuse?.referralRisk,riskReason:u.abuse?.referralRiskReason||'',email:u.verification?.email?.status||'unverified',phone:u.verification?.phone?.status||'unverified',youtube:u.youtubeTask?.status,tiktok:u.tiktokTask?.status,vip:!!u.vip,vipTier:u.vipTier||'normal',accountStatus:u.accountStatus||'active',createdAt:u.createdAt}));
  res.json({ok:true,users:rows});
});
app.get('/api/admin/withdrawals', auth, requireAdmin, (req,res) => res.json({ok:true,withdrawals:Object.values(db.withdrawals).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,100)}));
app.get('/api/admin/proofs', auth, requireAdmin, (req,res) => {
  const rows=[];
  for(const u of Object.values(db.users)) for(const platform of ['youtube','tiktok']) {
    const st=u[`${platform}Task`]; if(st?.status==='pending') rows.push({userId:u.id,username:u.username,firstName:u.firstName,platform,status:st.status,submittedAt:st.submittedAt,attempts:st.attempts,reason:st.reason,confidence:st.visionConfidence||0,proofHash:st.proofHash||''});
  }
  res.json({ok:true,proofs:rows});
});
app.get('/api/admin/proof-image/:hash', auth, requireAdmin, (req,res) => {
  const record=db.proofHashes?.[String(req.params.hash)];
  if(!record?.path || !fs.existsSync(record.path)) return res.status(404).end();
  res.type(record.mime || 'image/jpeg').sendFile(path.resolve(record.path));
});
app.post('/api/admin/proofs/:platform/:userId', auth, requireAdmin, (req,res)=>{
  if(!['youtube','tiktok'].includes(req.params.platform)) return res.status(400).json({ok:false,error:'Invalid platform.'});
  const target=db.users[String(req.params.userId)]; if(!target) return res.status(404).json({ok:false,error:'User not found.'});
  const action=req.body.action==='approve'?'approve':'reject';
  const changed=action==='approve' ? social.approve(target,req.params.platform) : social.reject(target,req.params.platform);
  saveUsers(); audit(`social_${action}`,req.tgUser.id,{platform:req.params.platform,userId:target.id,rewarded:changed});
  res.json({ok:true,changed});
});
app.get('/api/admin/cash-withdrawals', auth, requireAdmin, (req,res)=>res.json({ok:true,withdrawals:Object.values(db.cashWithdrawals||{}).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,100)}));
app.post('/api/admin/cash-withdrawals/:id', auth, requireAdmin, (req,res)=>{
  const wd=(db.cashWithdrawals||{})[String(req.params.id)]; if(!wd||wd.status!=='pending') return res.status(404).json({ok:false,error:'Pending cash withdrawal not found.'});
  const u=db.users[String(wd.userId)]; const action=req.body.action==='paid'?'paid':'rejected'; wd.status=action; wd.processedAt=new Date().toISOString();
  if(action==='rejected'&&u) u.cashBalance=Number(u.cashBalance||0)+Number(wd.amount||0); saveUsers();
  fs.writeFileSync(path.join(__dirname,'data','cash-withdrawals.json'),JSON.stringify(db.cashWithdrawals||{},null,2)); audit(`cash_withdrawal_${action}`,req.tgUser.id,{id:wd.id,userId:wd.userId,amount:wd.amount}); res.json({ok:true,status:action});
});

app.get('/api/admin/audit', auth, requireAdmin, (req,res)=>res.json({ok:true,audit:(db.audit||[]).slice(-200).reverse()}));
app.post('/api/admin/withdrawals/:id', auth, requireAdmin, (req,res)=>{
  const wd=db.withdrawals[String(req.params.id)]; if(!wd||wd.status!=='pending') return res.status(404).json({ok:false,error:'Pending withdrawal not found.'});
  const action=req.body.action==='paid'?'paid':'rejected', target=db.users[String(wd.userId)];
  wd.status=action; wd.processedAt=new Date().toISOString();
  if(action==='rejected'&&target) target.points+=wd.points;
  if(action==='paid'&&target){ target.withdrawalCount=Number(target.withdrawalCount||0)+1; engagement.syncAchievements(target); }
  saveWithdrawals(); saveUsers(); audit(`withdrawal_${action}`,req.tgUser.id,{id:wd.id,userId:wd.userId,points:wd.points});
  res.json({ok:true,status:action});
});
app.get('/admin', (req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

app.get('/videos', (req,res) => res.sendFile(path.join(__dirname,'public','videos.html')));
app.get('/whatsapp', (req,res) => res.sendFile(path.join(__dirname,'public','whatsapp.html')));
app.get('/r/:code', (req,res) => res.redirect(`/?ref=${encodeURIComponent(req.params.code)}`));

app.listen(cfg.PORT, () => console.log(`🌐 Xfunds v5 website: http://localhost:${cfg.PORT}`));
