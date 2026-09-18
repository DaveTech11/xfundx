require('dotenv').config();
const fs = require('fs');
const path = require('path');

const channels = [1,2,3,4,5]
  .map(i => process.env[`REQUIRED_CHANNEL_${i}`])
  .filter(Boolean).map(v => v.trim());

const videoTasks = [1,2,3,4,5,6]
  .map(i => ({
    id: `video_${i}`,
    title: process.env[`VIDEO_${i}_TITLE`] || `Video ${i}`,
    platform: (process.env[`VIDEO_${i}_PLATFORM`] || 'generic').toLowerCase(),
    url: process.env[`VIDEO_${i}_URL`] || '',
    reward: Number(process.env[`VIDEO_${i}_REWARD`] || process.env.POINTS_PER_VIDEO || 100)
  }))
  .filter(v => v.url);

if (!videoTasks.length && process.env.VIDEO_URL) {
  videoTasks.push({ id:'video_1', title:'Featured video', url:process.env.VIDEO_URL, reward:Number(process.env.POINTS_PER_VIDEO || 100) });
}

// Admin-created videos are persisted separately so the admin can add/remove
// watch tasks without editing .env or redeploying the app.
const adminVideoFile = path.join(__dirname, 'data', 'videos.json');
try {
  if (fs.existsSync(adminVideoFile)) {
    const saved = JSON.parse(fs.readFileSync(adminVideoFile, 'utf8'));
    if (Array.isArray(saved)) videoTasks.push(...saved);
  }
} catch (e) {
  console.warn('Could not load data/videos.json:', e.message);
}

module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  ADMIN_ID: Number(process.env.ADMIN_ID || 8941598516),
  ADMIN_IDS: String(process.env.ADMIN_IDS || process.env.ADMIN_ID || '8941598516,7161177100').split(',').map(v=>Number(v.trim())).filter(Boolean),
  BOT_USERNAME: (process.env.BOT_USERNAME || '').replace(/^@/, ''),
  APP_URL: (process.env.APP_URL || 'http://xfund.duckdns.org').replace(/\/$/, ''),
  PORT: Number(process.env.PORT || 3000),
  REQUIRED_CHANNELS: channels,
  POINTS_PER_TASK: Number(process.env.POINTS_PER_TASK || 100),
  POINTS_PER_VIDEO: Number(process.env.POINTS_PER_VIDEO || 100),
  NGN_PER_100_POINTS: Number(process.env.NGN_PER_100_POINTS || 0.5),
  REFERRAL_REWARD_POINTS: Number(process.env.REFERRAL_REWARD_POINTS || 100),
  WITHDRAW_MIN_POINTS: Number(process.env.WITHDRAW_MIN_POINTS || 5000),
  WITHDRAW_MAX_POINTS: Number(process.env.WITHDRAW_MAX_POINTS || 5000),
  DAILY_REWARD_POINTS: Number(process.env.DAILY_REWARD_POINTS || 500),
  CASH_WHEEL_ENABLED: !/^false$/i.test(process.env.CASH_WHEEL_ENABLED || 'true'),
  CASH_WITHDRAW_MIN_NGN: Number(process.env.CASH_WITHDRAW_MIN_NGN || 50),
  CASH_WITHDRAW_MAX_NGN: Number(process.env.CASH_WITHDRAW_MAX_NGN || 100000),
  VIP_DAILY_CLAIMS: Number(process.env.VIP_DAILY_CLAIMS || 3),
  VIP_GOLD_DAILY_CLAIMS: Number(process.env.VIP_GOLD_DAILY_CLAIMS || 4),
  VIP_DIAMOND_DAILY_CLAIMS: Number(process.env.VIP_DIAMOND_DAILY_CLAIMS || 5),
  VIP_WITHDRAW_MIN_POINTS: Number(process.env.VIP_WITHDRAW_MIN_POINTS || 100),
  VIP_OWNER_USERNAME: (process.env.VIP_OWNER_USERNAME || 'lovexdev').replace(/^@/, ''),
  VIDEO_WATCH_SECONDS: Number(process.env.VIDEO_WATCH_SECONDS || 30),
  VIDEO_URL: process.env.VIDEO_URL || '',
  VIDEO_TASKS: videoTasks,
  WHATSAPP_CONNECT_REWARD_POINTS: Number(process.env.WHATSAPP_CONNECT_REWARD_POINTS || 100),
  MAX_WHATSAPP_CONNECTIONS: Number(process.env.MAX_WHATSAPP_CONNECTIONS || 3),
  // Pairing protection. These are in-memory limits; use a reverse proxy/WAF
  // as well for internet-facing deployments.
  WA_PAIRING_COOLDOWN_MS: Number(process.env.WA_PAIRING_COOLDOWN_MS || 30000),
  WA_PAIRING_CODE_TTL_MS: Number(process.env.WA_PAIRING_CODE_TTL_MS || 180000),
  WA_PAIRING_MAX_ATTEMPTS_PER_HOUR: Number(process.env.WA_PAIRING_MAX_ATTEMPTS_PER_HOUR || 8),
  WA_AUTH_DIR: process.env.WA_AUTH_DIR || './data/whatsapp-auth',
  WA_GROUP_INVITES: String(process.env.WA_GROUP_INVITES || '').split(',').map(x=>x.trim()).filter(Boolean),
  WA_CHANNEL_JIDS: String(process.env.WA_CHANNEL_JIDS || '').split(',').map(x=>x.trim()).filter(Boolean),
  DEMO_MODE: /^true$/i.test(process.env.DEMO_MODE || 'false'),
  // Social follow/join tasks: 2 YouTube channels + 3 TikTok accounts.
  YOUTUBE_TASKS: [1,2].map(i => ({
    id:`youtube_${i}`,
    url:process.env[`YOUTUBE_${i}_URL`] || '',
    name:process.env[`YOUTUBE_${i}_NAME`] || `YouTube Channel ${i}`,
    title:process.env[`YOUTUBE_${i}_TITLE`] || `Join YouTube channel ${i}`,
    reward:Number(process.env[`YOUTUBE_${i}_REWARD`] || 250),
    minConfidence:Number(process.env[`YOUTUBE_${i}_VISION_MIN_CONFIDENCE`] || 0.90)
  })).filter(x=>x.url),
  TIKTOK_TASKS: [1,2,3].map(i => ({
    id:`tiktok_${i}`,
    url:process.env[`TIKTOK_${i}_URL`] || '',
    name:process.env[`TIKTOK_${i}_NAME`] || `TikTok Account ${i}`,
    title:process.env[`TIKTOK_${i}_TITLE`] || `Follow TikTok account ${i}`,
    reward:Number(process.env[`TIKTOK_${i}_REWARD`] || 250),
    minConfidence:Number(process.env[`TIKTOK_${i}_VISION_MIN_CONFIDENCE`] || 0.90)
  })).filter(x=>x.url),
  // Legacy aliases are retained for compatibility.
  YOUTUBE_CHANNEL_URL: process.env.YOUTUBE_1_URL || process.env.YOUTUBE_CHANNEL_URL || '',
  YOUTUBE_CHANNEL_NAME: process.env.YOUTUBE_1_NAME || process.env.YOUTUBE_CHANNEL_NAME || 'Your YouTube Channel',
  YOUTUBE_TASK_TITLE: process.env.YOUTUBE_1_TITLE || process.env.YOUTUBE_TASK_TITLE || 'Join our YouTube channel',
  YOUTUBE_TASK_REWARD: Number(process.env.YOUTUBE_1_REWARD || process.env.YOUTUBE_TASK_REWARD || 250),
  YOUTUBE_VISION_MIN_CONFIDENCE: Number(process.env.YOUTUBE_1_VISION_MIN_CONFIDENCE || process.env.YOUTUBE_VISION_MIN_CONFIDENCE || 0.90),
  TIKTOK_ACCOUNT_URL: process.env.TIKTOK_1_URL || process.env.TIKTOK_ACCOUNT_URL || '',
  TIKTOK_ACCOUNT_NAME: process.env.TIKTOK_1_NAME || process.env.TIKTOK_ACCOUNT_NAME || 'Your TikTok',
  TIKTOK_TASK_TITLE: process.env.TIKTOK_1_TITLE || process.env.TIKTOK_TASK_TITLE || 'Follow our TikTok page',
  TIKTOK_TASK_REWARD: Number(process.env.TIKTOK_1_REWARD || process.env.TIKTOK_TASK_REWARD || 250),
  TIKTOK_VISION_MIN_CONFIDENCE: Number(process.env.TIKTOK_1_VISION_MIN_CONFIDENCE || process.env.TIKTOK_VISION_MIN_CONFIDENCE || 0.90),
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL || 'gpt-5.6-luna',
  // Signs the anonymous cookie issued to users who join from the plain
  // website instead of the Telegram bot/Mini App. Set this in .env for
  // production — without it, sessions can't be verified across restarts
  // and everyone visiting the web gets a fresh account each time.
  WEB_SESSION_SECRET: process.env.WEB_SESSION_SECRET || '',
  ABUSE_HASH_SECRET: process.env.ABUSE_HASH_SECRET || process.env.WEB_SESSION_SECRET || 'change-me-abuse-secret',
  WEB_JOIN_RATE_LIMIT: Number(process.env.WEB_JOIN_RATE_LIMIT || 10),
  WEB_JOIN_RATE_WINDOW_MS: Number(process.env.WEB_JOIN_RATE_WINDOW_MS || 60 * 60 * 1000),
  SOCIAL_SUBMIT_RATE_LIMIT: Number(process.env.SOCIAL_SUBMIT_RATE_LIMIT || 3),
  SOCIAL_SUBMIT_RATE_WINDOW_MS: Number(process.env.SOCIAL_SUBMIT_RATE_WINDOW_MS || 15 * 60 * 1000),
  REFERRAL_FARM_WINDOW_HOURS: Number(process.env.REFERRAL_FARM_WINDOW_HOURS || 24),
  REFERRAL_FARM_MAX_ACCOUNTS: Number(process.env.REFERRAL_FARM_MAX_ACCOUNTS || 3),
  BOT_CHECK_REQUIRED: !/^false$/i.test(process.env.BOT_CHECK_REQUIRED || 'true'),
  EMAIL_VERIFICATION_REQUIRED: !/^false$/i.test(process.env.EMAIL_VERIFICATION_REQUIRED || 'true'),
  PHONE_VERIFICATION_REQUIRED: !/^false$/i.test(process.env.PHONE_VERIFICATION_REQUIRED || 'true'),
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || '',
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM: process.env.TWILIO_FROM || '',
  VIDEO_HEARTBEAT_SECONDS: Number(process.env.VIDEO_HEARTBEAT_SECONDS || 5),
  // Daily email reminders for users with a verified email.
  DAILY_REWARD_EMAIL_ENABLED: !/^false$/i.test(process.env.DAILY_REWARD_EMAIL_ENABLED || 'true'),
  DAILY_REWARD_EMAIL_HOUR_UTC: Number(process.env.DAILY_REWARD_EMAIL_HOUR_UTC || 8),
  DAILY_REWARD_EMAIL_MINUTE_UTC: Number(process.env.DAILY_REWARD_EMAIL_MINUTE_UTC || 0),
  DAILY_REWARD_EMAIL_BATCH_SIZE: Number(process.env.DAILY_REWARD_EMAIL_BATCH_SIZE || 25),
  GLOBAL_RATE_LIMIT: Number(process.env.GLOBAL_RATE_LIMIT || 180),
  GLOBAL_RATE_WINDOW_MS: Number(process.env.GLOBAL_RATE_WINDOW_MS || 60 * 1000),
  REQUEST_TIMEOUT_MS: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
  MISSION_REWARDS: {
    first_video: Number(process.env.MISSION_FIRST_VIDEO || 150),
    three_videos: Number(process.env.MISSION_THREE_VIDEOS || 300),
    first_whatsapp: Number(process.env.MISSION_FIRST_WHATSAPP || 250),
    three_referrals: Number(process.env.MISSION_THREE_REFERRALS || 500),
    seven_day_streak: Number(process.env.MISSION_SEVEN_DAY_STREAK || 750),
    ten_thousand_lifetime: Number(process.env.MISSION_10000_LIFETIME || 1000),
    first_youtube: Number(process.env.MISSION_FIRST_YOUTUBE || 300),
    first_tiktok: Number(process.env.MISSION_FIRST_TIKTOK || 300),
    three_social: Number(process.env.MISSION_THREE_SOCIAL || 750)
  }
};
