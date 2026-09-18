const crypto = require('crypto');
const cfg = require('./config');
const { db, saveUsers } = require('./store');

const LEVELS = [
  {level:1,title:'Newbie',xp:0}, {level:5,title:'Active Earner',xp:2500},
  {level:10,title:'Pro',xp:10000}, {level:25,title:'Elite',xp:25000}, {level:50,title:'Xfunds Legend',xp:50000}
];
const VIP_TIERS = {
  normal:{label:'Normal',dailyClaims:1,withdrawMin:null},
  silver:{label:'VIP Silver',dailyClaims:3,withdrawMin:100},
  gold:{label:'VIP Gold',dailyClaims:4,withdrawMin:100},
  diamond:{label:'VIP Diamond',dailyClaims:5,withdrawMin:100}
};
const ACHIEVEMENTS = [
  ['first_video','🎬 First Video','Complete your first video',u=>Object.keys(u.videoClaims||{}).length>=1],
  ['first_referral','👥 First Referral','Get your first qualified referral',u=>Number(u.qualifiedReferrals||0)>=1],
  ['first_withdrawal','💰 First Withdrawal','Complete your first withdrawal',u=>Number(u.withdrawalCount||0)>=1],
  ['streak_7','🔥 7-Day Streak','Reach a 7-day check-in streak',u=>Number(u.checkInStreak||0)>=7],
  ['vip','⭐ VIP','Become a VIP member',u=>!!u.vip],
  ['top_earner','🏆 Top Earner','Reach 10,000 lifetime points',u=>Number(u.lifetimePoints||0)>=10000],
  ['legend','💎 100K Lifetime','Reach 100,000 lifetime points',u=>Number(u.lifetimePoints||0)>=100000]
];
const WHEEL_REWARDS = [
  {type:'points',amount:100},{type:'points',amount:250},{type:'cash',amount:5},
  {type:'points',amount:500},{type:'cash',amount:10},{type:'points',amount:750},
  {type:'cash',amount:20},{type:'points',amount:1000}
];

function tierKey(user){
  if(!user.vip) return 'normal';
  return VIP_TIERS[user.vipTier] ? user.vipTier : 'silver';
}
function tierInfo(user){ return VIP_TIERS[tierKey(user)]; }
function getLevel(lifetime){
  const xp=Number(lifetime||0); let current=LEVELS[0];
  for(const l of LEVELS){ if(xp>=l.xp) current=l; }
  const next=LEVELS.find(l=>l.xp>xp) || null;
  return {level:current.level,title:current.title,xp,nextXp:next?.xp||current.xp,progress:next?Math.min(100,Math.round((xp-current.xp)/(next.xp-current.xp)*100)):100};
}
function achievements(user){
  user.achievements=user.achievements||{};
  return ACHIEVEMENTS.map(([id,title,desc,test])=>({id,title,description:desc,unlocked:!!user.achievements[id]||test(user),claimed:!!user.achievements[id]}));
}
function syncAchievements(user){
  user.achievements=user.achievements||{}; let changed=false;
  for(const [id,, ,test] of ACHIEVEMENTS){ if(!user.achievements[id] && test(user)){ user.achievements[id]={unlockedAt:new Date().toISOString()}; changed=true; } }
  if(changed) saveUsers();
  return changed;
}
function leaderboard(limit=10){
  return Object.values(db.users).sort((a,b)=>Number(b.lifetimePoints||0)-Number(a.lifetimePoints||0)).slice(0,limit).map((u,i)=>({rank:i+1,id:u.id,name:u.firstName||u.username||`User ${u.id}`,username:u.username||'',points:Number(u.lifetimePoints||0),level:getLevel(u.lifetimePoints)}));
}
function wheelToday(user){
  const today=new Date().toISOString().slice(0,10); user.wheelClaims=user.wheelClaims||{date:null,count:0};
  if(user.wheelClaims.date!==today) user.wheelClaims={date:today,count:0};
  return user.wheelClaims;
}
function spinWheel(user){
  const w=wheelToday(user), limit=user.vip ? 2 : 1;
  if(w.count>=limit) return {ok:false,error:`Wheel limit reached (${w.count}/${limit}).`};
  const prize=WHEEL_REWARDS[crypto.randomInt(WHEEL_REWARDS.length)]; w.count++;
  const points=prize.type==='cash'
    ? Math.max(1,Math.round((Number(prize.amount)/cfg.NGN_PER_100_POINTS)*100))
    : Number(prize.amount);
  user.points=Number(user.points||0)+points; user.lifetimePoints=Number(user.lifetimePoints||0)+points;
  user.rewardLog=Array.isArray(user.rewardLog)?user.rewardLog:[];
  user.rewardLog.push({amount:points,displayAmount:Number(prize.amount),type:prize.type,reason:'daily_wheel',at:new Date().toISOString()});
  saveUsers(); syncAchievements(user);
  return {ok:true,reward:{type:prize.type,amount:Number(prize.amount),pointsCredited:points},spinCount:w.count,spinLimit:limit};
}
function redeemPromo(user,code){
  const key=String(code||'').trim().toUpperCase(); const p=(db.promos||{})[key];
  if(!p || !p.active) return {ok:false,error:'Invalid or inactive promo code.'};
  if(p.expiresAt && new Date(p.expiresAt).getTime()<Date.now()) return {ok:false,error:'This promo code has expired.'};
  user.promoClaims=user.promoClaims||{}; if(user.promoClaims[key]) return {ok:false,error:'You have already redeemed this code.'};
  if(p.vipOnly && !user.vip) return {ok:false,error:'This promo code is for VIP users only.'};
  if(Number(p.maxUses||0)>0 && Number(p.used||0)>=Number(p.maxUses)) return {ok:false,error:'This promo code has reached its usage limit.'};
  const reward=Math.max(1,Math.floor(Number(p.reward||0))); user.promoClaims[key]=new Date().toISOString(); p.used=Number(p.used||0)+1;
  user.points=Number(user.points||0)+reward; user.lifetimePoints=Number(user.lifetimePoints||0)+reward;
  user.rewardLog=Array.isArray(user.rewardLog)?user.rewardLog:[]; user.rewardLog.push({amount:reward,reason:`promo:${key}`,at:new Date().toISOString()});
  saveUsers(); return {ok:true,reward,code:key};
}
module.exports={LEVELS,VIP_TIERS,ACHIEVEMENTS,WHEEL_REWARDS,tierKey,tierInfo,getLevel,achievements,syncAchievements,leaderboard,spinWheel,redeemPromo};
