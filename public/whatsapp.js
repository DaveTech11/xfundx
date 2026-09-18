const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand()}
const $=id=>document.getElementById(id);
let max=0,reward=0,pollTimer=null,currentConnectionId=null,currentMode=null;

function headers(json=true){
  const h={};
  if(json)h['content-type']='application/json';
  if(tg?.initData)h['x-telegram-init-data']=tg.initData;
  if(!tg?.initData&&location.hostname==='localhost')h['x-demo-user']='1000001';
  return h;
}
async function api(url,opt={}){
  const r=await fetch(url,{...opt,credentials:'include',headers:{...headers(opt.method!=='GET'),...(opt.headers||{})}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'Request failed');
  return d;
}
function toast(s){$('toast').textContent=s;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2800)}
function formatRemaining(ts){
  if(!ts)return '';
  const sec=Math.max(0,Math.ceil((Number(ts)-Date.now())/1000));
  return sec?` • code expires in ${sec}s`:' • code expired';
}
function showCode(d){
  if(!d.pairingCode){
    $('result').innerHTML='<div class="notice">⏳ Pairing is active, but the code is not currently available. You can request a fresh code.</div>';
    return;
  }
  $('result').innerHTML=`<div class="muted">In WhatsApp: Linked devices → Link a device → Link with phone number.</div>
  <div class="code">${String(d.pairingCode)}</div>
  <div class="timer" id="codeTimer">${formatRemaining(d.pairingCodeExpiresAt)}</div>
  <button class="btn" id="refreshCode" type="button">🔄 Generate new code</button>`;
  $('refreshCode').onclick=()=>refreshCode(d.id);
}
function showQr(d){
  if(d.qr)$('result').innerHTML=`<div class="muted">Scan this QR from WhatsApp → Linked devices.</div><img src="${d.qr}" alt="WhatsApp QR code" style="width:320px;max-width:100%;margin-top:10px;border-radius:16px;background:white;padding:8px"><div class="muted" style="margin-top:8px">Keep this page open while scanning.</div>`;
}
function render(list){
  $('limit').textContent=`${list.filter(x=>['pairing','connected'].includes(x.status)).length}/${max} active connections • +${reward} points per successful connection`;
  $('connections').innerHTML=list.length?list.map(x=>{
    const j=x.autoJoin?.joined?.length||0,f=x.autoJoin?.failed?.length||0;
    const label=x.maskedNumber||x.number;
    return `<div class="connection">
      <div class="row"><b>${label}</b><span class="${x.status==='connected'?'ok':''}">${x.status}</span></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${x.rewarded?'Reward credited':'Pairing in progress'} • ${x.method==='qr'?'QR pairing':'Code pairing'}</div>
      ${x.status==='connected'?`<div class="muted" style="font-size:12px;margin-top:5px">Auto-join: ${j} joined${f?` • ${f} failed`:''}</div>`:''}
      ${x.status!=='logged_out'?`<button class="btn" style="margin-top:10px" data-disconnect="${x.id}">Disconnect</button>`:''}
    </div>`;
  }).join(''):'<p class="muted">No WhatsApp connections yet.</p>';
  document.querySelectorAll('[data-disconnect]').forEach(b=>b.onclick=()=>disconnect(b.dataset.disconnect));
}
async function load(){
  try{const d=await api('/api/whatsapp/connections',{method:'GET'});max=d.max;reward=d.reward;render(d.connections)}
  catch(e){toast(e.message)}
}
function startPolling(id,mode){
  currentConnectionId=id;currentMode=mode;clearInterval(pollTimer);
  pollTimer=setInterval(async()=>{
    try{
      const d=await api(`/api/whatsapp/pair/${encodeURIComponent(id)}`,{method:'GET'});
      if(d.status==='connected'){
        clearInterval(pollTimer);$('result').innerHTML='<div class="notice">✅ WhatsApp connected successfully. Your connection reward has been credited if eligible.</div>';await load();return;
      }
      if(mode==='qr')showQr(d);else showCode(d);
    }catch(e){clearInterval(pollTimer);toast(e.message)}
  },1500);
}
async function pair(mode){
  try{
    const number=$('number').value.trim();
    if(!number)return toast('Enter your WhatsApp number first.');
    $('pairCode').disabled=true;$('pairQr').disabled=true;$('result').innerHTML='<div class="muted">Starting secure pairing session…</div>';
    const d=await api('/api/whatsapp/pair',{method:'POST',body:JSON.stringify({number,mode})});
    if(d.qr)showQr(d);else showCode(d);
    startPolling(d.connectionId,mode);await load();
  }catch(e){toast(e.message);$('result').innerHTML='';}
  finally{$('pairCode').disabled=false;$('pairQr').disabled=false}
}
async function refreshCode(id){
  try{
    $('refreshCode').disabled=true;
    const d=await api(`/api/whatsapp/pair/${encodeURIComponent(id)}/refresh`,{method:'POST',body:'{}'});
    showCode({id,pairingCode:d.pairingCode,pairingCodeExpiresAt:d.pairingCodeExpiresAt});
  }catch(e){toast(e.message)}
  finally{const b=$('refreshCode');if(b)b.disabled=false}
}
async function disconnect(id){
  try{clearInterval(pollTimer);await api('/api/whatsapp/disconnect',{method:'POST',body:JSON.stringify({connectionId:id})});toast('Disconnected');await load()}
  catch(e){toast(e.message)}
}
$('pairCode').onclick=()=>pair('code');$('pairQr').onclick=()=>pair('qr');load();
