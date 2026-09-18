const crypto = require('crypto');
const cfg = require('./config');

function validateInitData(initData) {
  if (!cfg.BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(cfg.BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'))) return null;
  } catch { return null; }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  try {
    const user = JSON.parse(params.get('user') || '{}');
    return user?.id ? user : null;
  } catch { return null; }
}

// Verifies a Telegram Login Widget payload (used by plain website visitors
// who aren't inside the Telegram Mini App). Same signature scheme as
// validateInitData, but the secret key is SHA256(bot_token) directly
// rather than HMAC("WebAppData", bot_token), and every field except
// `hash` (and empty fields) goes into the check string.
function validateLoginWidget(data) {
  if (!cfg.BOT_TOKEN || !data || !data.hash || !data.id) return null;
  const { hash, ...rest } = data;
  const checkString = Object.keys(rest)
    .filter(k => rest[k] !== undefined && rest[k] !== null && rest[k] !== '')
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(cfg.BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(String(hash), 'hex'), Buffer.from(calculated, 'hex'))) return null;
  } catch { return null; }
  const authDate = Number(data.auth_date || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  return { id: data.id, first_name: data.first_name || '', last_name: data.last_name || '', username: data.username || '', photo_url: data.photo_url || '' };
}

async function telegramApi(method, payload) {
  if (!cfg.BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const res = await fetch(`https://api.telegram.org/bot${cfg.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function checkChannelMembership(userId) {
  if (!cfg.REQUIRED_CHANNELS.length) return { complete: false, channels: [], configurationError: true };
  const channels = [];
  for (const channel of cfg.REQUIRED_CHANNELS) {
    let joined = false;
    let error = null;
    try {
      const member = await telegramApi('getChatMember', { chat_id: channel, user_id: Number(userId) });
      joined = ['member', 'administrator', 'creator'].includes(member.status) || (member.status === 'restricted' && member.is_member);
    } catch (e) { error = e.message; }
    channels.push({ channel, joined, error });
  }
  // BUGFIX: this used to require exactly 5 configured channels
  // (`channels.length === 5`), so membership — and therefore the
  // channel task, referral qualification, and withdrawals — could
  // never complete unless all 5 REQUIRED_CHANNEL_n slots were filled
  // with real, working channels. Now it just requires every
  // *configured* channel to be joined, whatever the count.
  return { complete: channels.length > 0 && channels.every(c => c.joined), channels, configurationError: false };
}

// Used to forward a web-uploaded proof screenshot (raw bytes, no
// Telegram file_id yet) to the admin for review.
async function telegramSendPhotoBuffer(chatId, buffer, filename, extra = {}) {
  if (!cfg.BOT_TOKEN) throw new Error('BOT_TOKEN is not configured');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([buffer]), filename);
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') continue;
    form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(`https://api.telegram.org/bot${cfg.BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'sendPhoto failed');
  return data.result;
}

module.exports = { validateInitData, validateLoginWidget, telegramApi, checkChannelMembership, telegramSendPhotoBuffer };
