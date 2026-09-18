const cfg = require('./config');
const { db, saveUsers } = require('./store');
const crypto = require('crypto');

function todayUTC() { return new Date().toISOString().slice(0, 10); }
function ngnFromPoints(points) { return Number(points || 0) / 100 * cfg.NGN_PER_100_POINTS; }
function referralCode(id) { return `XF${Number(id).toString(36).toUpperCase()}`; }
function hashValue(value) {
  return crypto.createHmac('sha256', cfg.ABUSE_HASH_SECRET).update(String(value || '')).digest('hex');
}

function ensureUser(tgUser, ref = null, meta = {}) {
  const id = String(tgUser.id);
  if (!db.users[id]) {
    db.users[id] = {
      id: Number(tgUser.id), username: tgUser.username || '', firstName: tgUser.first_name || 'User',
      points: 0, lifetimePoints: 0, cashBalance: 0, cashRewardLog: [], referredBy: null, referralQualified: false,
      referrals: [], qualifiedReferrals: 0, referralRewardLog: [], referralMilestones: {},
      taskClaims: { channels: false, whatsapp: false },
      videoClaims: {}, videoStarts: {}, videoWatch: {}, videoHeartbeatAt: {},
      whatsapp: { number: '', status: 'unlinked' },
      whatsappConnections: [],
      bank: { bankName: '', accountNumber: '', accountName: '', status: 'unverified', reviewedAt: null },
      lastCheckIn: null, checkInStreak: 0, dailyClaims: { date: null, count: 0 }, vip: false, missionClaims: {},
      youtubeTask: { status:'not_started', attempts:0, submittedAt:null, reviewedAt:null, reason:'' },
      tiktokTask: { status:'not_started', attempts:0, submittedAt:null, reviewedAt:null, reason:'' },
      authSource: tgUser.webOnly ? 'web' : 'telegram',
      vipTier: 'normal', withdrawalCount: 0, achievements: {}, wheelClaims: {date:null,count:0}, promoClaims: {}, accountStatus:'active',
      createdAt: new Date().toISOString()
    };
    if (ref) {
      const referrer = Object.values(db.users).find(u => referralCode(u.id) === String(ref).toUpperCase() || String(u.id) === String(ref));
      if (referrer && String(referrer.id) !== id) {
        db.users[id].referredBy = String(referrer.id);
        if (!referrer.referrals.includes(Number(tgUser.id))) referrer.referrals.push(Number(tgUser.id));
        if (tgUser.webOnly && meta.ip) {
          const cutoff = Date.now() - cfg.REFERRAL_FARM_WINDOW_HOURS * 3600000;
          const siblings = Object.values(db.users).filter(x =>
            String(x.referredBy || '') === String(referrer.id) &&
            x.id !== Number(tgUser.id) &&
            new Date(x.createdAt || 0).getTime() >= cutoff
          );
          const ipHash = hashValue(meta.ip);
          const deviceHash = meta.deviceId ? hashValue(meta.deviceId) : null;
          const sameSignal = siblings.filter(x => x.abuse && (
            (ipHash && x.abuse.ipHash === ipHash) ||
            (deviceHash && x.abuse.deviceHash === deviceHash)
          ));
          if (sameSignal.length >= Math.max(1, cfg.REFERRAL_FARM_MAX_ACCOUNTS - 1)) {
            db.users[id].abuse.referralRisk = true;
            db.users[id].abuse.referralRiskReason = 'Multiple recent referred web accounts share IP/device fingerprint.';
          }
        }
      }
    }
    saveUsers();
  } else {
    db.users[id].username = tgUser.username || db.users[id].username;
    db.users[id].firstName = tgUser.first_name || db.users[id].firstName;
    if (!Number.isFinite(Number(db.users[id].cashBalance))) db.users[id].cashBalance = 0;
    if (!Array.isArray(db.users[id].cashRewardLog)) db.users[id].cashRewardLog = [];
    if (!db.users[id].taskClaims) db.users[id].taskClaims = {};
    if (!db.users[id].videoClaims) db.users[id].videoClaims = {};
    if (!db.users[id].videoStarts) db.users[id].videoStarts = {};
    if (!db.users[id].videoWatch) db.users[id].videoWatch = {};
    if (!db.users[id].videoHeartbeatAt) db.users[id].videoHeartbeatAt = {};
    if (!Array.isArray(db.users[id].whatsappConnections)) db.users[id].whatsappConnections = [];
    if (!Array.isArray(db.users[id].referralRewardLog)) db.users[id].referralRewardLog = [];
    if (!db.users[id].referralMilestones || typeof db.users[id].referralMilestones !== 'object') db.users[id].referralMilestones = {};
    if (!db.users[id].whatsapp) db.users[id].whatsapp = { number:'', status:'unlinked' };
    if (!Number.isFinite(db.users[id].checkInStreak)) db.users[id].checkInStreak = 0;
    if (!db.users[id].dailyClaims || typeof db.users[id].dailyClaims !== 'object') db.users[id].dailyClaims = { date:null, count:0 };
    if (typeof db.users[id].vip !== 'boolean') db.users[id].vip = false;
    if (!db.users[id].missionClaims) db.users[id].missionClaims = {};
    if (!db.users[id].youtubeTask) db.users[id].youtubeTask = { status:'not_started', attempts:0, submittedAt:null, reviewedAt:null, reason:'' };
    if (!db.users[id].tiktokTask) db.users[id].tiktokTask = { status:'not_started', attempts:0, submittedAt:null, reviewedAt:null, reason:'' };
    saveUsers();
  }
  return db.users[id];
}

function addCash(user, amount, reason='cash_reward') {
  amount = Number(amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  user.cashBalance = Number(user.cashBalance || 0) + amount;
  user.cashRewardLog = Array.isArray(user.cashRewardLog) ? user.cashRewardLog : [];
  user.cashRewardLog.push({ amount, reason, at: new Date().toISOString() });
  if (user.cashRewardLog.length > 100) user.cashRewardLog = user.cashRewardLog.slice(-100);
  saveUsers();
  return true;
}

function addPoints(user, amount, reason='reward') {
  amount = Number(amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  user.points += amount;
  user.lifetimePoints += amount;
  user.rewardLog = Array.isArray(user.rewardLog) ? user.rewardLog : [];
  user.rewardLog.push({ amount, reason, at: new Date().toISOString() });
  if (user.rewardLog.length > 100) user.rewardLog = user.rewardLog.slice(-100);
  saveUsers();
  return true;
}

function award(user, amount, key) {
  if (user.taskClaims?.[key]) return false;
  user.taskClaims[key] = true;
  addPoints(user, amount, key);
  saveUsers();
  return true;
}

function claimVideo(user, videoId, amount) {
  user.videoClaims = user.videoClaims || {};
  if (user.videoClaims[videoId]) return false;
  user.videoClaims[videoId] = { claimedAt: new Date().toISOString(), reward: Number(amount) };
  addPoints(user, amount, `video:${videoId}`);
  saveUsers();
  return true;
}

function maybeQualifyReferral(user) {
  if (!user || user.referralQualified || !user.referredBy) return false;
  if (user.abuse?.referralRisk) return false;

  // A referral qualifies only after two meaningful actions:
  // 1) required Telegram channel task is complete;
  // 2) the referred user has a verified WhatsApp connection.
  const waVerified = user.whatsapp?.status === 'verified' ||
    (user.whatsappConnections || []).some(x => x.status === 'connected');
  if (!user.taskClaims?.channels || !waVerified) return false;

  const referrer = db.users[String(user.referredBy)];
  if (!referrer || String(referrer.id) === String(user.id)) return false;

  user.referralQualified = true;
  referrer.referrals = Array.isArray(referrer.referrals) ? referrer.referrals : [];
  if (!referrer.referrals.includes(Number(user.id))) referrer.referrals.push(Number(user.id));

  const reward = Math.max(0, Math.floor(Number(cfg.REFERRAL_REWARD_POINTS || 0)));
  if (reward > 0) {
    referrer.points = Number(referrer.points || 0) + reward;
    referrer.lifetimePoints = Number(referrer.lifetimePoints || 0) + reward;
    referrer.referralRewardLog = Array.isArray(referrer.referralRewardLog) ? referrer.referralRewardLog : [];
    referrer.referralRewardLog.push({
      referredUserId:Number(user.id), amount:reward, level:1,
      at:new Date().toISOString()
    });
    referrer.rewardLog = Array.isArray(referrer.rewardLog) ? referrer.rewardLog : [];
    referrer.rewardLog.push({amount:reward,reason:`referral:${user.id}`,at:new Date().toISOString()});
    referrer.qualifiedReferrals = Number(referrer.qualifiedReferrals || 0) + 1;
  }

  // Level-2 bonus is capped and points-only.
  if (referrer.referredBy && String(referrer.referredBy) !== String(user.id)) {
    const level2 = db.users[String(referrer.referredBy)];
    const bonus2 = Math.max(0, Math.floor(reward * 0.10));
    if (level2 && bonus2 > 0 && !level2.abuse?.referralRisk) {
      level2.points = Number(level2.points || 0) + bonus2;
      level2.lifetimePoints = Number(level2.lifetimePoints || 0) + bonus2;
      level2.referralRewardLog = Array.isArray(level2.referralRewardLog) ? level2.referralRewardLog : [];
      level2.referralRewardLog.push({
        referredUserId:Number(user.id), amount:bonus2, level:2,
        at:new Date().toISOString()
      });
      level2.rewardLog = Array.isArray(level2.rewardLog) ? level2.rewardLog : [];
      level2.rewardLog.push({amount:bonus2,reason:'referral:level2',at:new Date().toISOString()});
    }
  }

  saveUsers();
  return true;
}

function referralStats(user) {
  const direct = Array.isArray(user.referrals) ? user.referrals : [];
  const qualified = [];
  const pending = [];
  for (const id of direct) {
    const child = db.users[String(id)];
    if (!child) continue;
    (child.referralQualified ? qualified : pending).push({
      id:Number(child.id),
      username:child.username || '',
      firstName:child.firstName || 'User',
      qualified:!!child.referralQualified,
      createdAt:child.createdAt || null
    });
  }
  return {
    code: referralCode(user.id),
    qualifiedReferrals:Number(user.qualifiedReferrals || 0),
    directInvites:direct.length,
    pendingReferrals:pending.length,
    rewardPerQualified:Number(cfg.REFERRAL_REWARD_POINTS || 0),
    level2Rate:0.10,
    qualified,
    pending,
    milestones: [
      {n:5,reward:500},{n:10,reward:1200},{n:25,reward:3500},{n:50,reward:8000}
    ].map(x => ({
      ...x,
      unlocked:Number(user.qualifiedReferrals||0)>=x.n,
      claimed:!!user.referralMilestones?.[x.n],
      claimable:Number(user.qualifiedReferrals||0)>=x.n&&!user.referralMilestones?.[x.n]
    }))
  };
}

function claimMission(user, missionId, reward) {
  user.missionClaims = user.missionClaims || {};
  if (user.missionClaims[missionId]) return false;
  user.missionClaims[missionId] = { claimedAt: new Date().toISOString(), reward: Number(reward) };
  addPoints(user, reward, `mission:${missionId}`);
  saveUsers();
  return true;
}

function missionStatus(user) {
  const videos = Object.keys(user.videoClaims || {}).length;
  const wa = (user.whatsappConnections || []).filter(x => ['pairing','connected'].includes(x.status)).length;
  const refs = Number(user.qualifiedReferrals || 0);
  const streak = Number(user.checkInStreak || 0);
  const missions = [
    {id:'first_video', title:'Complete your first video', reward:cfg.MISSION_REWARDS.first_video, progress:Math.min(videos,1), goal:1},
    {id:'three_videos', title:'Complete 3 videos', reward:cfg.MISSION_REWARDS.three_videos, progress:Math.min(videos,3), goal:3},
    {id:'first_whatsapp', title:'Connect your first WhatsApp', reward:cfg.MISSION_REWARDS.first_whatsapp, progress:Math.min(wa,1), goal:1},
    {id:'three_referrals', title:'Reach 3 qualified referrals', reward:cfg.MISSION_REWARDS.three_referrals, progress:Math.min(refs,3), goal:3},
    {id:'seven_day_streak', title:'Reach a 7-day check-in streak', reward:cfg.MISSION_REWARDS.seven_day_streak, progress:Math.min(streak,7), goal:7},
    {id:'ten_thousand_lifetime', title:'Earn 10,000 lifetime points', reward:cfg.MISSION_REWARDS.ten_thousand_lifetime, progress:Math.min(Number(user.lifetimePoints||0),10000), goal:10000},
    {id:'first_youtube', title:'Complete the YouTube task', reward:cfg.MISSION_REWARDS.first_youtube, progress:user.youtubeTask?.status === 'approved' ? 1 : 0, goal:1},
    {id:'first_tiktok', title:'Complete the TikTok task', reward:cfg.MISSION_REWARDS.first_tiktok, progress:user.tiktokTask?.status === 'approved' ? 1 : 0, goal:1}
  ].map(m => ({...m, completed: !!user.missionClaims?.[m.id], claimable: !user.missionClaims?.[m.id] && m.progress >= m.goal}));
  return missions;
}

function claimDaily(user) {
  const today = todayUTC();
  user.dailyClaims = user.dailyClaims || { date:null, count:0 };
  if (user.dailyClaims.date !== today) user.dailyClaims = { date: today, count: 0 };
  const tier = user.vipTier || (user.vip ? 'silver' : 'normal');
  const limit = tier === 'diamond' ? cfg.VIP_DIAMOND_DAILY_CLAIMS : tier === 'gold' ? cfg.VIP_GOLD_DAILY_CLAIMS : user.vip ? cfg.VIP_DAILY_CLAIMS : 1;
  if (Number(user.dailyClaims.count || 0) >= limit) return false;
  const previousDate = user.lastCheckIn;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  if (Number(user.dailyClaims.count || 0) === 0) {
    user.checkInStreak = previousDate === yesterday ? Number(user.checkInStreak || 0) + 1 : 1;
    user.lastCheckIn = today;
  }
  user.dailyClaims.count = Number(user.dailyClaims.count || 0) + 1;
  addPoints(user, cfg.DAILY_REWARD_POINTS, 'daily');
  saveUsers();
  return true;
}


module.exports = { ensureUser, award, claimVideo, addPoints, addCash, maybeQualifyReferral, referralStats, claimDaily, claimMission, missionStatus, ngnFromPoints, referralCode, todayUTC };
