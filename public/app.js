const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const $ = id => document.getElementById(id);
let config = null, me = null;
const deviceId = localStorage.getItem('xf_device_id') || crypto.randomUUID();
localStorage.setItem('xf_device_id', deviceId);
let botCheck = JSON.parse(localStorage.getItem('xf_bot_check') || 'null');
const ref = new URLSearchParams(location.search).get('ref') || localStorage.getItem('xf_ref') || '';
if (ref) localStorage.setItem('xf_ref', ref);

function headers(json=true){
  const h={};
  if(json)h['content-type']='application/json';
  if(tg?.initData)h['x-telegram-init-data']=tg.initData;
  if(ref)h['x-referral-code']=ref;
  h['x-device-id']=deviceId;
  if(botCheck?.id && botCheck?.answer){h['x-bot-challenge-id']=botCheck.id;h['x-bot-challenge-answer']=botCheck.answer;}
  if(!tg?.initData && location.hostname==='localhost')h['x-demo-user']='1000001';
  return h;
}
async function api(url,opt={},retried=false){
  const r=await fetch(url,{...opt,credentials:'include',headers:{...headers(opt.method!=='GET'),...(opt.headers||{})}});
  const d=await r.json().catch(()=>({}));
  if(r.status===428 && d.botCheck && !retried){
    const q=await fetch('/api/security/challenge').then(x=>x.json());
    const answer=window.prompt(`Quick bot-check: ${q.question}`);
    if(answer===null) throw new Error('Bot-check cancelled.');
    botCheck={id:q.id,answer:String(answer).trim()}; localStorage.setItem('xf_bot_check',JSON.stringify(botCheck));
    return api(url,opt,true);
  }
  if(!r.ok)throw new Error(d.error||'Request failed');return d;
}
function toast(s){$('toast').textContent=s;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2800)}
function money(n){return `₦${Number(n||0).toFixed(2)}`}
function statusText(status){return status==='verified'?'✅ Verified':status==='pending'?'⏳ Pending verification':status==='rejected'?'❌ Rejected':'Not linked';}
function socialStatusText(status){return status==='approved'?'✅ Completed':status==='pending'?'⏳ Proof under review':status==='rejected'?'❌ Proof rejected — try a clearer screenshot':'🟡 Not submitted yet';}

function fileToDataUrl(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function submitSocialProof(platform, file){
  if(!file) return;
  if(file.size > 7*1024*1024){toast('Screenshot is too large (max ~7MB).');return;}
  try{
    toast('Uploading proof…');
    const dataUrl = await fileToDataUrl(file);
    const d = await api(`/api/tasks/social/${platform}/submit`,{method:'POST',body:JSON.stringify({image:dataUrl})});
    toast(d.message || 'Proof submitted');
    await refresh();
  }catch(e){ toast(e.message); }
}

function wireSocialTask(platform, prefix){
  const openBtn=$(`${prefix}Open`), uploadBtn=$(`${prefix}Upload`), fileInput=$(`${prefix}File`);
  if(!openBtn || !uploadBtn || !fileInput) return;
  const task = (config?.socialTasks||[]).find(x=>x.id===platform) || config?.[platform];
  const state = me?.[`${platform}Task`];
  if(task?.url){ openBtn.href=task.url; } else { openBtn.style.display='none'; uploadBtn.disabled=true; }
  uploadBtn.onclick=()=>fileInput.click();
  fileInput.onchange=()=>{ const f=fileInput.files?.[0]; fileInput.value=''; submitSocialProof(platform,f); };
  if(state?.status) $(`${prefix}Status`).textContent=socialStatusText(state.status);
}

function renderSocialTasks(){
  const tasks=config?.socialTasks||[];
  tasks.forEach((task,idx)=>{
    const prefix=task.id==='youtube_1'?'yt':task.id==='tiktok_1'?'tk':`social${idx}`;
    const reward=$(`${prefix}Reward`), status=$(`${prefix}Status`), open=$(`${prefix}Open`);
    const state=me?.[`${task.id}Task`];
    if(reward) reward.textContent=`+${Number(task.reward||0).toLocaleString()} PTS`;
    if(status) status.textContent=socialStatusText(state?.status);
    if(open) open.href=task.url||'#';
  });
}

function renderSocialCards(){
  const wrap=$('socialTasks'); if(!wrap) return;
  const tasks=config?.socialTasks||[];
  wrap.innerHTML=tasks.map((t,i)=>{
    const state=me?.[`${t.id}Task`]?.status||'not_started';
    const icon=t.platform==='youtube'?'▶️':'🎵';
    return `<article class="task glass"><div class="task-head"><span class="icon">${icon}</span><span class="reward">+${Number(t.reward||0).toLocaleString()} PTS</span></div><h3>${escapeHtml(t.title)}</h3><p>${t.platform==='youtube'?'Subscribe/join':'Follow'} <b>${escapeHtml(t.accountName||'')}</b>, then upload proof.</p><a class="btn" href="${escapeAttr(t.url||'#')}" target="_blank" rel="noopener" style="text-decoration:none;text-align:center;display:inline-block;margin-bottom:8px">${icon} Open ${t.platform==='youtube'?'YouTube':'TikTok'}</a><input type="file" id="socialFile${i}" accept="image/*" style="display:none"><button class="btn primary" id="socialUpload${i}">🧾 Upload proof</button><div class="timer" id="socialStatus${i}">${socialStatusText(state)}</div></article>`;
  }).join('');
  tasks.forEach((t,i)=>{
    const b=$(`socialUpload${i}`), f=$(`socialFile${i}`); if(!b||!f)return;
    b.onclick=()=>f.click(); f.onchange=()=>{const file=f.files?.[0];f.value='';submitSocialProof(t.id,file);}
  });
}
async function loadEarn(){
  try{
    const d=await api('/api/earn',{method:'GET'});
    if($('earnPotential')) $('earnPotential').textContent=`Up to +${Number(d.availablePoints||0).toLocaleString()} pts currently available`;
    if($('earnSummary')) $('earnSummary').textContent=`🔥 ${Number(d.streak||0)} day streak • ${Number(d.qualifiedReferrals||0)} qualified referrals`;
    if($('earnItems')) $('earnItems').innerHTML=(d.items||[]).map(x=>{
      const state=x.completed?'✅ Completed':x.available?'🟢 Available':'⏳ In progress';
      const reward=x.id==='referrals'?`+${Number(x.reward).toLocaleString()} per referral`:`+${Number(x.reward).toLocaleString()} pts`;
      return `<div style="border:1px solid var(--line);padding:11px;border-radius:14px;background:rgba(0,0,0,.12)"><div style="display:flex;justify-content:space-between;gap:8px"><b>${x.icon} ${x.title}</b><span class="reward">${reward}</span></div><div class="timer">${state}</div></div>`
    }).join('');
    if($('missions')) $('missions').innerHTML=(d.missions||[]).map(m=>{
      const pct=Math.min(100,Math.round((Number(m.progress)/Number(m.goal))*100));
      const state=m.completed?'Completed':m.claimable?'Ready to claim':'In progress';
      const button=m.claimable?`<button class="btn primary" onclick="claimMission('${m.id}')">Claim +${Number(m.reward).toLocaleString()}</button>`:'';
      return `<div style="border:1px solid var(--line);padding:13px;border-radius:15px;background:rgba(0,0,0,.12)"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div><b>${m.title}</b><div class="timer">${m.progress.toLocaleString()}/${m.goal.toLocaleString()} • ${state}</div></div><span class="reward">+${Number(m.reward).toLocaleString()}</span></div><div style="height:7px;border-radius:99px;background:rgba(255,255,255,.08);margin:10px 0;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--green)"></div></div>${button}</div>`;
    }).join('') || '<div class="timer">No missions available.</div>';
  }catch(e){}
}

async function loadExtras(){
  try{
    const period=$('leaderboardPeriod')?.value||'all'; const [lb, hist] = await Promise.all([api('/api/leaderboard?limit=5&period='+encodeURIComponent(period),{method:'GET'}), api('/api/history',{method:'GET'})]);
    if($('leaderboard')) $('leaderboard').innerHTML=(lb.leaderboard||[]).map(x=>`<div style="display:flex;justify-content:space-between;gap:8px;border:1px solid var(--line);padding:9px 11px;border-radius:12px"><span>${x.rank<=3?['🥇','🥈','🥉'][x.rank-1]:'#'+x.rank} ${String(x.name).replace(/</g,'&lt;')}</span><b>${Number(x.points).toLocaleString()} pts</b></div>`).join('') || '<div class="timer">No rankings yet.</div>';
    if($('history')) $('history').innerHTML=(hist.history||[]).slice(0,5).map(x=>`<div style="display:flex;justify-content:space-between;gap:8px;border:1px solid var(--line);padding:9px 11px;border-radius:12px"><span>${String(x.reason).replace(/^video:/,'Video ')}</span><b class="reward">+${Number(x.amount).toLocaleString()}</b></div>`).join('') || '<div class="timer">No rewards yet.</div>';
  }catch(e){}
}

async function loadReferralCenter(){
  try{
    const d=await api('/api/referrals',{method:'GET'});
    if($('refDirect'))$('refDirect').textContent=Number(d.directInvites||0).toLocaleString();
    if($('refQualified'))$('refQualified').textContent=Number(d.qualifiedReferrals||0).toLocaleString();
    if($('refPending'))$('refPending').textContent=Number(d.pendingReferrals||0).toLocaleString();
    if($('refLink'))$('refLink').textContent=d.referralLink||'';
    if($('copyRefCenter'))$('copyRefCenter').onclick=async()=>{
      try{await navigator.clipboard.writeText(d.referralLink);toast('Referral link copied')}
      catch{prompt('Copy your referral link:',d.referralLink)}
    };
    if($('refMilestones'))$('refMilestones').innerHTML=(d.milestones||[]).map(m=>{
      const state=m.claimed?'✅ Claimed':m.claimable?'🟢 Ready to claim':m.unlocked?'🔓 Unlocked':'🔒 Locked';
      const btn=m.claimable?`<button class="btn primary" onclick="claimReferralMilestone(${m.n})">Claim +${Number(m.reward).toLocaleString()}</button>`:'';
      return `<div style="border:1px solid var(--line);padding:10px;border-radius:13px;display:flex;justify-content:space-between;gap:10px;align-items:center"><span><b>${m.n} qualified referrals</b><div class="timer">${state}</div></span><span class="reward">+${Number(m.reward).toLocaleString()} pts ${btn}</span></div>`;
    }).join('');
    const people=[...(d.qualified||[]).map(x=>({...x,_state:'Qualified'})),...(d.pending||[]).map(x=>({...x,_state:'Pending'}))];
    if($('refPeople'))$('refPeople').innerHTML=people.slice(0,12).map(x=>`<div style="display:flex;justify-content:space-between;gap:8px;border:1px solid var(--line);padding:8px 10px;border-radius:11px"><span>${escapeHtml(x.firstName||'User')}${x.username?' @'+escapeHtml(x.username):''}</span><span class="timer">${x._state}</span></div>`).join('') || '<div class="timer">No referrals yet.</div>';
  }catch(e){}
}
async function claimReferralMilestone(n){
  try{
    const d=await api(`/api/referrals/milestone/${encodeURIComponent(n)}/claim`,{method:'POST',body:'{}'});
    toast(`+${Number(d.reward||0).toLocaleString()} referral milestone points`);
    await refresh(); await loadReferralCenter();
  }catch(e){toast(e.message)}
}

async function loadRewardsCenter(){
  try{ const d=await api('/api/rewards-center',{method:'GET'}); if($('cashBalance')) $('cashBalance').textContent=money(d.cashBalance); }
  catch(e){}
}
async function rewardAction(url,label){try{const d=await api(url,{method:'POST',body:'{}'});const r=d.reward||{};const text=r.type==='cash'?`${label}: ${money(r.amount)}`:`${label}: +${Number(r.amount||d.reward||0).toLocaleString()} points`;if($('bonusStatus'))$('bonusStatus').textContent='🎉 '+text;toast(text);await refresh();await loadRewardsCenter();}catch(e){toast(e.message)}}
if($('scratchCard')) $('scratchCard').onclick=()=>rewardAction('/api/rewards/scratch','Scratch reward');
if($('mysteryBox')) $('mysteryBox').onclick=()=>rewardAction('/api/rewards/mystery','Mystery reward');
if($('streakBonus')) $('streakBonus').onclick=()=>rewardAction('/api/rewards/streak-bonus','Streak bonus');
if($('cashWithdrawBtn')) $('cashWithdrawBtn').onclick=async()=>{try{const amount=Number($('cashWithdrawAmount').value);const d=await api('/api/cash-withdraw',{method:'POST',body:JSON.stringify({amount})});$('cashWithdrawStatus').textContent=`⏳ Withdrawal ${d.id} submitted for ${money(d.amount)}.`;$('cashWithdrawAmount').value='';await loadRewardsCenter();}catch(e){toast(e.message)}};

async function boot(){
  try{
    config=await fetch('/api/config').then(r=>r.json());
    if($('channels')) renderChannels();
    me=(await api('/api/me',{method:'GET'})).user;
    renderMe();
    renderTelegramLink();
    renderSocialCards();
    renderSocialTasks();
    loadExtras();
    loadEarn();
    loadReferralCenter();
    loadRewardsCenter();
  }catch(e){toast(e.message);}
}

// Plain website visitors get an anonymous account with no real Telegram
// id, so Telegram can never confirm they joined the required channels —
// that's what made channel tasks and withdrawals dead-end for them. This
// banner lets them link a real Telegram account (Telegram Login Widget)
// right on the website, no bot required. Not shown inside the Telegram
// Mini App, where the account is already a real one.
window.onTelegramAuth = async function(tgAuthUser){
  try{
    await api('/api/auth/telegram-login',{method:'POST',body:JSON.stringify(tgAuthUser)});
    toast('Telegram account linked');
    me=(await api('/api/me',{method:'GET'})).user;
    renderMe(); renderTelegramLink(); refresh();
  }catch(e){toast(e.message);}
};
function renderTelegramLink(){
  const box=$('telegramLinkBox');
  if(!box) return;
  if(tg?.initData || me.telegramLinked){ box.style.display='none'; return; }
  box.style.display='';
  if(!config.botUsername){ box.innerHTML='<div class="timer">Telegram linking isn\'t configured yet.</div>'; return; }
  box.innerHTML=`<div class="timer" style="margin-bottom:8px">Link your Telegram account to unlock channel tasks and withdrawals from the website.</div><div id="tgWidgetHost"></div>`;
  const s=document.createElement('script');
  s.async=true; s.src='https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-login', config.botUsername);
  s.setAttribute('data-size','large');
  s.setAttribute('data-radius','12');
  s.setAttribute('data-onauth','onTelegramAuth(user)');
  s.setAttribute('data-request-access','write');
  $('tgWidgetHost').appendChild(s);
}
function renderChannels(){
  $('channels').innerHTML=(config.requiredChannels||[]).map(c=>`<div class="channel"><a href="${c.url}" target="_blank">${c.name}</a><span>Join ↗</span></div>`).join('') || '<div class="channel bad">Channels not configured</div>';
}
function renderMe(){
  if($('points')) $('points').textContent=Number(me.points).toLocaleString();
  if($('naira')) $('naira').textContent=`≈ ${money(me.naira)}`;
  if($('rate')) $('rate').textContent=`100 points = ${money(config.ngnPer100Points)}`;
  if($('refCode')) $('refCode').textContent=me.referralCode;
  if($('refCount')) $('refCount').textContent=me.qualifiedReferrals;
  if($('avatar')) $('avatar').textContent=(me.firstName||'XF').slice(0,2).toUpperCase();
  if($('waStatus')) $('waStatus').textContent=`${me.whatsappConnections?.length||0}/${config.maxWhatsappConnections} connections`;
  if($('bankName')) $('bankName').value=me.bank?.bankName||'';
  if($('accountNumber')) $('accountNumber').value=me.bank?.accountNumber||'';
  if($('accountName')) $('accountName').value=me.bank?.accountName||'';
  if($('bankStatus')) $('bankStatus').textContent=`Bank status: ${statusText(me.bank?.status)}`;
  if($('checkinStatus')) { const dc=me.dailyClaims?.date===new Date().toISOString().slice(0,10)?Number(me.dailyClaims?.count||0):0; const dl=me.vip?3:1; $('checkinStatus').textContent=me.vip?`VIP claims today: ${dc}/${dl}`:(me.lastCheckIn?`Last claim: ${me.lastCheckIn}`:'Not claimed yet'); }
  if($('channelStatus')) $('channelStatus').textContent=me.channelsComplete?'✅ Currently complete':'Membership will be checked live';
}
async function claimMission(id){try{const d=await api(`/api/missions/${encodeURIComponent(id)}/claim`,{method:'POST',body:'{}'});toast(d.rewarded?`+${Number(d.mission?.reward||0).toLocaleString()} mission points`:'Already claimed');await refresh();}catch(e){toast(e.message)}}

async function refresh(){me=(await api('/api/me',{method:'GET'})).user;renderMe();renderTelegramLink();renderSocialTasks();renderVerification();loadExtras();loadEarn();
    loadRewardsCenter();}

if($('verifyChannels')) $('verifyChannels').onclick=async()=>{try{const d=await api('/api/tasks/channels/verify',{method:'POST',body:'{}'});toast(d.rewarded?`+${config.pointsPerTask} points earned`:'Already rewarded');await refresh();}catch(e){toast(e.message);}};
if($('checkin')) $('checkin').onclick=async()=>{try{const d=await api('/api/tasks/checkin',{method:'POST',body:'{}'});toast(d.rewarded?`+${config.dailyRewardPoints||500} daily points`:`Daily limit reached (${d.dailyCount||1}/${d.dailyLimit||1})`);await refresh();}catch(e){toast(e.message);}};
if($('saveBank')) $('saveBank').onclick=async()=>{try{await api('/api/bank',{method:'POST',body:JSON.stringify({bankName:$('bankName').value,accountNumber:$('accountNumber').value,accountName:$('accountName').value})});toast('Bank submitted for verification');await refresh();}catch(e){toast(e.message);}};
if($('copyRef')) $('copyRef').onclick=async()=>{const link=`${location.origin}/r/${me.referralCode}`;try{await navigator.clipboard.writeText(link);toast('Referral link copied')}catch{prompt('Copy your referral link:',link)}};
if($('withdrawPoints')){
  $('withdrawPoints').min=me.vip?100:(config.withdrawMinPoints||5000);
  $('withdrawPoints').placeholder=me.vip?`100 – ${config.withdrawMaxPoints}`:`${config.withdrawMinPoints} only`;
  function updateValue(){const p=Math.max(0,Number($('withdrawPoints').value||0));$('withdrawValue').textContent=`≈ ${money(p/100*config.ngnPer100Points)}`}
  $('withdrawPoints').oninput=updateValue;
  $('maxBtn').onclick=()=>{$('withdrawPoints').value=me.vip?Math.min(config.withdrawMaxPoints,me.points):(me.points>=config.withdrawMinPoints?config.withdrawMinPoints:'');updateValue()};
  $('withdrawBtn').onclick=async()=>{try{const p=Number($('withdrawPoints').value);const d=await api('/api/withdraw',{method:'POST',body:JSON.stringify({points:p})});toast(`Withdrawal ${d.id} submitted (${money(d.naira)})`);$('withdrawPoints').value='';updateValue();await refresh();}catch(e){toast(e.message)}};
}
if($('vipRequest')) $('vipRequest').onclick=async()=>{try{const d=await api('/api/vip/request',{method:'POST',body:'{}'});$('vipStatus').textContent=d.vip?'⭐ VIP is already active.':`${d.message||''}`;toast(d.message||'VIP request sent to owner');}catch(e){toast(e.message)}};
if($('toast')) boot();
setTimeout(()=>renderVerification(),500);
['email','phone'].forEach(type=>{const b=$(`send${type==='email'?'Email':'Phone'}Code`),c=$(`confirm${type==='email'?'Email':'Phone'}Code`);if(b)b.onclick=()=>requestVerification(type);if(c)c.onclick=()=>confirmVerification(type);});

async function requestVerification(type){
  const value=$(type==='email'?'verifyEmail':'verifyPhone').value.trim();
  if(!value){toast(`Enter your ${type} first.`);return;}
  try{const d=await api(`/api/verify/${type}/request`,{method:'POST',body:JSON.stringify(type==='email'?{email:value}:{phone:value})});toast(d.message||'Code sent');}
  catch(e){toast(e.message)}
}
async function confirmVerification(type){
  const code=$(type==='email'?'verifyEmailCode':'verifyPhoneCode').value.trim();
  if(!code){toast('Enter the verification code.');return;}
  try{await api(`/api/verify/${type}/confirm`,{method:'POST',body:JSON.stringify({code})});toast(`${type==='email'?'Email':'Phone'} verified.`);await refresh();}
  catch(e){toast(e.message)}
}
function renderVerification(){
  const v=me?.verification||{};
  const emailStatus=$('emailVerifyStatus'), phoneStatus=$('phoneVerifyStatus');
  if(emailStatus) emailStatus.textContent=v.email?.status==='verified'?'✅ Verified':v.email?.status==='pending'?'⏳ Code sent':'Not verified';
  if(phoneStatus) phoneStatus.textContent=v.phone?.status==='verified'?'✅ Verified':v.phone?.status==='pending'?'⏳ Code sent':'Not verified';
}

async function loadEngagement(){
  try{
    const d=await api('/api/engagement');
    const l=d.level||{};
    if($('levelBox')) $('levelBox').innerHTML=`<b>Level ${l.level}: ${l.title}</b><br>${Number(l.xp||0).toLocaleString()} XP • ${l.nextXp&&l.nextXp>l.xp?`next at ${Number(l.nextXp).toLocaleString()}`:'MAX LEVEL'}`;
    if($('levelBar')) $('levelBar').style.width=`${Number(l.progress||0)}%`;
    if($('streakBox')) $('streakBox').textContent=`🔥 ${Number(me?.checkInStreak||0)} day check-in streak • ${me?.vip?d.vipTierInfo.label:'Normal account'}`;
    if($('achievements')) $('achievements').innerHTML=(d.achievements||[]).map(a=>`<div style="padding:9px;border:1px solid var(--line);border-radius:12px;opacity:${a.unlocked?'1':'.55'}"><b>${a.title}</b><div class="timer">${a.description} • ${a.unlocked?'Unlocked':'Locked'}</div></div>`).join('');
    if($('wheelStatus')) $('wheelStatus').textContent=`Spins today: ${d.wheel.spinCount}/${d.wheel.spinLimit} • Rewards: ${d.wheel.rewards.join(', ')} pts`;
  }catch(e){}
}
if($('spinWheel')) $('spinWheel').onclick=async()=>{try{const d=await api('/api/wheel/spin',{method:'POST',body:'{}'}); const r=d.reward||{}; const msg=r.type==='cash'?`🎉 You won ${money(r.amount)} cash!`:`🎉 You won +${Number(r.amount||r.pointsCredited||0).toLocaleString()} points!`; $('wheelStatus').textContent=msg; toast(msg); await refresh();}catch(e){toast(e.message)}};
if($('redeemPromo')) $('redeemPromo').onclick=async()=>{try{const code=$('promoCode').value.trim();const d=await api('/api/promo/redeem',{method:'POST',body:JSON.stringify({code})});$('promoStatus').textContent=`🎉 +${Number(d.reward).toLocaleString()} points added.`;$('promoCode').value='';toast('Promo redeemed');await refresh();}catch(e){toast(e.message)}};
const _oldBoot=boot; boot=async function(){await _oldBoot();await loadEngagement();};
const _oldRefresh=refresh; refresh=async function(){await _oldRefresh();await loadEngagement();};
setTimeout(()=>loadEngagement(),800);

if($('leaderboardPeriod')) $('leaderboardPeriod').onchange=()=>loadExtras();

/* xFunds V14 Rewards + Games + Boost Center */
(async function v14(){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function mount(){
    if(document.getElementById('v14Center')) return;
    const anchor=document.querySelector('#missionsPanel')||document.querySelector('.section-title');
    if(!anchor) return setTimeout(mount,300);
    const wrap=document.createElement('div'); wrap.id='v14Center'; wrap.innerHTML=`
      <div class="section-title"><h2>🚀 Xfunds Boost Center</h2><small>Games • levels • campaigns • referral bonuses</small></div>
      <section class="grid2" style="margin-bottom:14px">
        <article class="panel glass"><h3>🎮 Mini Games</h3><p class="timer">Win points only. No cash is staked.</p>
          <div style="display:grid;gap:8px">
            <div style="display:flex;gap:8px;flex-wrap:wrap"><select id="v14CoinChoice" class="field"><option value="heads">Heads</option><option value="tails">Tails</option></select><button class="btn primary" id="v14Coin">🪙 Coin flip</button></div>
            <div style="display:flex;gap:8px"><input id="v14Dice" class="field" type="number" min="1" max="6" placeholder="1–6"><button class="btn" id="v14DiceBtn">🎲 Roll dice</button></div>
            <div style="display:flex;gap:8px"><input id="v14Guess" class="field" type="number" min="1" max="10" placeholder="1–10"><button class="btn" id="v14GuessBtn">🔢 Guess</button></div>
          </div><div id="v14GameStatus" class="timer" style="margin-top:10px"></div>
        </article>
        <article class="panel glass"><h3>🔥 Active Boosts</h3><div id="v14Campaigns" class="timer">Loading…</div><h3 style="margin-top:14px">🤝 Referral bonus</h3><div class="timer">Direct referrals earn the configured reward. Level-2 referrals earn a small points bonus when qualified.</div><div id="v14Milestones" style="display:grid;gap:7px;margin-top:10px"></div></article>
      </section>`;
    anchor.parentNode.insertBefore(wrap,anchor);
  }
  mount();
  async function load(){
    try{
      const d=await api('/api/advanced');
      const el=document.getElementById('v14Campaigns'); if(!el)return;
      const c=d.campaigns||[];
      const ms=d.referralMilestones||[]; const me=document.getElementById('v14Milestones'); if(me) me.innerHTML=ms.map(x=>`<div style="padding:9px;border:1px solid var(--line);border-radius:12px"><b>${x.n} referrals</b> • +${Number(x.reward).toLocaleString()} pts ${x.claimed?'✅ Claimed':x.claimable?`<button class="btn primary" data-refmil="${x.n}">Claim</button>`:'🔒 Locked'}</div>`).join('');
      el.innerHTML=c.length?c.map(x=>`<div style="padding:10px;border:1px solid var(--line);border-radius:12px;margin-bottom:7px"><b>${esc(x.title)}</b> • <strong>${Number(x.multiplier).toFixed(2)}×</strong><br><span class="timer">${x.endsAt?'Ends '+new Date(x.endsAt).toLocaleString():'Active now'}</span></div>`).join(''):'<div class="timer">No active boost campaigns right now.</div>';
    }catch(e){}
  }
  async function play(url,body){try{const d=await api(url,{method:'POST',body:JSON.stringify(body)});const s=d.won?`🎉 You won +${Number(d.reward||0).toLocaleString()} points!`:`Result: ${d.result}. Keep trying!`;const el=document.getElementById('v14GameStatus');if(el)el.textContent=s;toast(s);await refresh();await load();}catch(e){toast(e.message)}}
  document.addEventListener('click',e=>{
    if(e.target.dataset.refmil) (async()=>{try{const d=await api('/api/referrals/milestone/'+e.target.dataset.refmil+'/claim',{method:'POST',body:'{}'});toast(`+${Number(d.reward).toLocaleString()} milestone points`);await refresh();await load()}catch(err){toast(err.message)}})();
    if(e.target.id==='v14Coin')play('/api/games/coinflip',{choice:document.getElementById('v14CoinChoice').value});
    if(e.target.id==='v14DiceBtn')play('/api/games/dice',{guess:document.getElementById('v14Dice').value});
    if(e.target.id==='v14GuessBtn')play('/api/games/guess',{guess:document.getElementById('v14Guess').value});
  });
  load(); setInterval(load,60000);
})();
