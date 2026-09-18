const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, saveUsers } = require('./store');

const FILE = path.join(__dirname, 'data', 'advanced.json');
function load(){ try{return fs.existsSync(FILE)?JSON.parse(fs.readFileSync(FILE,'utf8')):{campaigns:[],gameClaims:{}};}catch{return {campaigns:[],gameClaims:{}};} }
const state = load();
state.campaigns = Array.isArray(state.campaigns)?state.campaigns:[];
state.gameClaims = state.gameClaims && typeof state.gameClaims==='object'?state.gameClaims:{};
function save(){fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(state,null,2));}
function today(){return new Date().toISOString().slice(0,10)}
function addPoints(user, amount, reason){
  const n=Math.max(0,Math.floor(Number(amount)||0)); if(!n)return false;
  user.points=Number(user.points||0)+n; user.lifetimePoints=Number(user.lifetimePoints||0)+n;
  user.rewardLog=Array.isArray(user.rewardLog)?user.rewardLog:[];
  user.rewardLog.push({amount:n,reason,at:new Date().toISOString()});
  if(user.rewardLog.length>150) user.rewardLog=user.rewardLog.slice(-150);
  saveUsers(); return true;
}
function activeCampaigns(){const now=Date.now();return state.campaigns.filter(c=>c.active && (!c.startsAt||new Date(c.startsAt).getTime()<=now) && (!c.endsAt||new Date(c.endsAt).getTime()>=now));}
function multiplier(user=null){
  let m=activeCampaigns().reduce((x,c)=>x*Math.max(1,Number(c.multiplier)||1),1);
  const xp=Number(user?.lifetimePoints||0);
  if(xp>=50000)m*=1.5; else if(xp>=25000)m*=1.3; else if(xp>=10000)m*=1.15; else if(xp>=2500)m*=1.05;
  return Number(m.toFixed(2));
}
function dailyGame(user, game, limit=3){
  const id=String(user.id), d=today(); state.gameClaims[id]=state.gameClaims[id]||{};
  const x=state.gameClaims[id][game];
  if(!x||x.date!==d) state.gameClaims[id][game]={date:d,count:0};
  if(state.gameClaims[id][game].count>=limit)return false;
  state.gameClaims[id][game].count++; save(); return true;
}
function playCoin(user, choice){
  if(!['heads','tails'].includes(choice))return {ok:false,error:'Choose heads or tails.'};
  if(!dailyGame(user,'coinflip'))return {ok:false,error:'Daily coin-flip limit reached.'};
  const result=Math.random()<.5?'heads':'tails'; const won=result===choice; const reward=won?Math.round(100*multiplier(user)):0;
  if(reward)addPoints(user,reward,'game:coinflip'); return {ok:true,result,won,reward,multiplier:multiplier(user)};
}
function playDice(user, guess){
  const n=Number(guess); if(!Number.isInteger(n)||n<1||n>6)return {ok:false,error:'Guess a number from 1 to 6.'};
  if(!dailyGame(user,'dice'))return {ok:false,error:'Daily dice limit reached.'};
  const result=1+crypto.randomInt(6), won=result===n, reward=won?Math.round(300*multiplier(user)):50;
  if(reward)addPoints(user,reward,'game:dice'); return {ok:true,result,won,reward:won?reward:0,consolation:won?0:reward};
}
function playGuess(user, guess){
  const n=Number(guess); if(!Number.isInteger(n)||n<1||n>10)return {ok:false,error:'Guess a number from 1 to 10.'};
  if(!dailyGame(user,'guess'))return {ok:false,error:'Daily guessing limit reached.'};
  const result=1+crypto.randomInt(10), won=result===n, reward=won?Math.round(500*multiplier(user)):0;
  if(reward)addPoints(user,reward,'game:guess'); return {ok:true,result,won,reward};
}
function referralMilestone(user){
  const milestones=[{n:5,reward:500},{n:10,reward:1200},{n:25,reward:3500},{n:50,reward:8000}];
  user.referralMilestones=user.referralMilestones||{};
  const count=Number(user.qualifiedReferrals||0);
  return milestones.map(x=>({...x,unlocked:count>=x.n,claimed:!!user.referralMilestones[x.n],claimable:count>=x.n&&!user.referralMilestones[x.n]}));
}
function claimReferralMilestone(user,n){
  const item=referralMilestone(user).find(x=>x.n===Number(n));
  if(!item)return {ok:false,error:'Unknown referral milestone.'};
  if(!item.unlocked)return {ok:false,error:`You need ${item.n} qualified referrals.`};
  if(item.claimed)return {ok:false,error:'This milestone is already claimed.'};
  user.referralMilestones=user.referralMilestones||{}; user.referralMilestones[item.n]=new Date().toISOString();
  addPoints(user,item.reward,`referral:milestone:${item.n}`); return {ok:true,reward:item.reward,milestone:item.n};
}
function status(user){
  const id=String(user.id), d=today(); const games={};
  for(const g of ['coinflip','dice','guess']) games[g]=state.gameClaims[id]?.[g]?.date===d?state.gameClaims[id][g].count:0;
  return {games,multiplier:multiplier(user),referralMilestones:referralMilestone(user),campaigns:activeCampaigns().map(c=>({id:c.id,title:c.title,multiplier:c.multiplier,endsAt:c.endsAt||null}))};
}
function createCampaign(input){
  const title=String(input.title||'').trim().slice(0,80); const m=Number(input.multiplier); if(!title||!Number.isFinite(m)||m<1||m>5)throw new Error('Campaign title and multiplier 1–5 are required.');
  const c={id:`boost_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,title,multiplier:m,startsAt:input.startsAt||new Date().toISOString(),endsAt:input.endsAt||null,active:true,createdAt:new Date().toISOString()}; state.campaigns.unshift(c); save(); return c;
}
function disableCampaign(id){const c=state.campaigns.find(x=>x.id===id);if(!c)return false;c.active=false;save();return true}
function adminStats(){
 const users=Object.values(db.users); return {users:users.length,active:users.filter(u=>u.accountStatus==='active').length,vip:users.filter(u=>u.vip).length,totalPoints:users.reduce((n,u)=>n+Number(u.points||0),0),lifetimePoints:users.reduce((n,u)=>n+Number(u.lifetimePoints||0),0),cashBalance:users.reduce((n,u)=>n+Number(u.cashBalance||0),0),withdrawals:Object.keys(db.withdrawals||{}).length,activeCampaigns:activeCampaigns().length};
}
module.exports={state,save,activeCampaigns,multiplier,playCoin,playDice,playGuess,status,referralMilestone,claimReferralMilestone,createCampaign,disableCampaign,adminStats};
