const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand()}
const $=id=>document.getElementById(id);
let cfg=null,me=null;const deviceId=localStorage.getItem('xf_device_id')||crypto.randomUUID();localStorage.setItem('xf_device_id',deviceId);let botCheck=JSON.parse(localStorage.getItem('xf_bot_check')||'null');
const timers={}; // videoId -> { intervalId, required }
const progress={}; // videoId -> { watched, required }
let idx=0; // which video is currently shown

function headers(json=true){const h={};if(json)h['content-type']='application/json';if(tg?.initData)h['x-telegram-init-data']=tg.initData;if(deviceId)h['x-device-id']=deviceId;if(botCheck?.id&&botCheck?.answer){h['x-bot-challenge-id']=botCheck.id;h['x-bot-challenge-answer']=botCheck.answer;}if(!tg?.initData&&location.hostname==='localhost')h['x-demo-user']='1000001';return h}
async function api(url,opt={}){const r=await fetch(url,{...opt,credentials:'include',headers:{...headers(opt.method!=='GET'),...(opt.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Request failed');return d}
function toast(s){$('toast').textContent=s;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2500)}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escapeAttr(s){return String(s).replace(/"/g,'&quot;')}

function render(){
  $('balance').textContent=`💰 ${me.points.toLocaleString()} points`;
  const total=cfg.videos.length;
  if(!total){ $('videos').innerHTML='<div class="card glass"><div class="timer">No videos are configured right now.</div></div>'; return; }
  if(idx<0) idx=0; if(idx>=total) idx=total-1;
  const v=cfg.videos[idx];
  const claimed=!!me.videoClaims?.[v.id];
  const required=Number(v.watchSeconds||cfg.videoWatchSeconds);
  const watched=claimed?required:(progress[v.id]?.watched ?? Number(me.videoWatch?.[v.id]||0));
  $('videos').innerHTML=`<article class="card glass">
    <div class="row" style="margin-bottom:6px">
      <button class="btn" id="prevVideo" ${idx===0?'disabled':''}>← Prev</button>
      <div class="timer" style="margin:0">Video ${idx+1} of ${total}</div>
      <button class="btn" id="nextVideo" ${idx===total-1?'disabled':''}>Next →</button>
    </div>
    <h2 style="margin-top:4px">${v.platform==='tiktok'?'🎵 TikTok':v.platform==='youtube'?'▶️ YouTube':'🎬'} ${escapeHtml(v.title)}</h2>
    <div class="videoWrap"><iframe class="video" src="${escapeAttr(v.url)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
    <div class="timer" id="timer-current">${claimed?'✅ Already claimed':`+${v.reward} points • ${required}s of active watch time`}</div>
    <div class="row">
      <button class="btn ${claimed?'':'primary'}" ${claimed?'disabled':''} id="startBtn">${claimed?'Claimed':'▶ Start task'}</button>
      <button class="btn" id="claimBtn" disabled>Claim reward</button>
    </div>
  </article>`;
  $('prevVideo').onclick=()=>{idx--;render()};
  $('nextVideo').onclick=()=>{idx++;render()};
  $('startBtn').onclick=()=>start(v.id);
  $('claimBtn').onclick=()=>claim(v.id);
  if(!claimed && watched>0) markProgress(v.id, watched, required);
}

function markProgress(id, watched, required){
  progress[id]={watched,required};
  if(cfg.videos[idx]?.id!==id) return; // that video isn't the one on screen right now
  const el=$('timer-current'); const claimBtn=$('claimBtn');
  if(!el) return;
  if(watched>=required){ el.textContent='✅ Watch time complete — claim your points'; if(claimBtn) claimBtn.disabled=false; }
  else { el.textContent=`⏳ ${Math.ceil(required-watched)}s of active watching left (pauses if you switch tabs)`; if(claimBtn) claimBtn.disabled=true; }
}

// Only counts as "watching" while this tab is visible and focused —
// switching away or minimizing pauses the heartbeat, so the required
// watch time can't be satisfied by just leaving the task open. Moving
// between videos with Prev/Next doesn't pause it (see markProgress).
function isActivelyWatching(){ return document.visibilityState==='visible' && document.hasFocus(); }

async function start(id){
  try{
    const d=await api('/api/tasks/video/start',{method:'POST',body:JSON.stringify({videoId:id})});
    if(timers[id]) clearInterval(timers[id].intervalId);
    const required=d.watchSeconds;
    markProgress(id, 0, required);
    const intervalMs=(cfg.videoHeartbeatSeconds||5)*1000;
    const intervalId=setInterval(async ()=>{
      if(!isActivelyWatching()) return; // paused: tab hidden/unfocused
      try{
        const hb=await api('/api/tasks/video/heartbeat',{method:'POST',body:JSON.stringify({videoId:id})});
        markProgress(id, hb.watched, hb.required);
        if(hb.watched>=hb.required) clearInterval(intervalId);
      }catch(e){ /* ignore transient errors, next tick retries */ }
    }, intervalMs);
    timers[id]={intervalId, required};
    toast('Video task started — keep this tab open and focused');
  }catch(e){toast(e.message)}
}
async function claim(id){
  try{
    const d=await api('/api/tasks/video/claim',{method:'POST',body:JSON.stringify({videoId:id})});
    if(timers[id]) clearInterval(timers[id].intervalId);
    toast(d.rewarded?`🎉 +${cfg.videos.find(v=>v.id===id).reward} points earned`:'Already claimed');
    me=(await api('/api/me',{method:'GET'})).user;render()
  }catch(e){toast(e.message)}
}
(async()=>{try{cfg=await fetch('/api/config').then(r=>r.json());me=(await api('/api/me',{method:'GET'})).user;render()}catch(e){toast(e.message)}})();
