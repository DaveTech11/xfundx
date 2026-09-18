const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const cfg = require('./config');
const { db, saveUsers } = require('./store');
const { addPoints, maybeQualifyReferral } = require('./rewards');

fs.mkdirSync(cfg.WA_AUTH_DIR, { recursive: true });
const sessions = new Map();
const pairingAttempts = new Map();
const lastPairingAt = new Map();
const key = (u,c)=>`${u}:${c}`;
const clean = p=>String(p||'').replace(/\D/g,'').replace(/^00/,'');
const listFor = id => Array.isArray(db.users[String(id)]?.whatsappConnections) ? db.users[String(id)].whatsappConnections : [];
const newId=()=>`wa_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

function attemptKey(userId){ return String(userId); }
function pruneAttempts(userId){
  const now=Date.now(), key=attemptKey(userId);
  const arr=(pairingAttempts.get(key)||[]).filter(t=>now-t<3600000);
  pairingAttempts.set(key,arr); return arr;
}
function assertPairingAllowed(userId){
  const now=Date.now(), key=attemptKey(userId);
  const last=lastPairingAt.get(key)||0;
  if(now-last<cfg.WA_PAIRING_COOLDOWN_MS){
    const sec=Math.ceil((cfg.WA_PAIRING_COOLDOWN_MS-(now-last))/1000);
    throw new Error(`Please wait ${sec}s before starting another pairing.`);
  }
  const attempts=pruneAttempts(userId);
  if(attempts.length>=cfg.WA_PAIRING_MAX_ATTEMPTS_PER_HOUR)
    throw new Error('Pairing attempt limit reached. Try again later.');
  attempts.push(now); pairingAttempts.set(key,attempts); lastPairingAt.set(key,now);
}
function normalizeNumber(phone){
  const number=clean(phone);
  if(!/^[1-9][0-9]{7,14}$/.test(number)) throw new Error('Enter a valid international WhatsApp number, e.g. 2348012345678.');
  return number;
}
function maskNumber(number){
  const d=clean(number);
  if(d.length<=6) return `+${d}`;
  return `+${d.slice(0,3)}••••${d.slice(-3)}`;
}

function inviteCode(v){
  const m=String(v||'').trim().match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i);
  return m?m[1]:String(v||'').trim();
}
async function autoJoin(sock, record){
  const joined=[], failed=[];
  for(const target of cfg.WA_GROUP_INVITES){
    try{ const jid=await sock.groupAcceptInvite(inviteCode(target)); joined.push({type:'group',target,jid}); }
    catch(e){ failed.push({type:'group',target,error:e.message}); }
  }
  for(const jid of cfg.WA_CHANNEL_JIDS){
    try{
      if(typeof sock.newsletterFollow!=='function') throw new Error('Channel following is not supported by this Baileys version.');
      await sock.newsletterFollow(jid); joined.push({type:'channel',target:jid});
    }catch(e){ failed.push({type:'channel',target:jid,error:e.message}); }
  }
  record.autoJoin={attemptedAt:new Date().toISOString(),joined,failed};
  return record.autoJoin;
}

async function createSocket(userId, connectionId, authDir, record, mode='restore'){
  const {state,saveCreds}=await useMultiFileAuthState(authDir);
  const sock=makeWASocket({auth:state,printQRInTerminal:false,browser:Browsers.macOS('Chrome'),logger:pino({level:'silent'})});
  const st={sock,record,authDir,rewarded:!!record.rewarded,qr:null,qrDataUrl:null,pairingCode:null};
  sessions.set(key(userId,connectionId),st);
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async ({connection,lastDisconnect,qr})=>{
    const s=sessions.get(key(userId,connectionId)); if(!s)return;
    if(qr){
      s.qr=qr;
      try{s.qrDataUrl=await QRCode.toDataURL(qr,{width:320,margin:2})}catch{}
      record.status='pairing'; record.pairingCodeExpiresAt=null; saveUsers();
    }
    if(connection==='open'){
      record.status='connected';record.connectedAt=record.connectedAt||new Date().toISOString();
      record.pairingCode=null; record.pairingCodeExpiresAt=null;
      const target=db.users[String(userId)];
      if(target){
        // The successful Baileys connection is the new verification signal.
        target.whatsapp = { number:record.number, status:'verified', verifiedAt:new Date().toISOString() };
        if(!s.rewarded){
          addPoints(target,cfg.WHATSAPP_CONNECT_REWARD_POINTS,`whatsapp:${connectionId}`);
          s.rewarded=true;record.rewarded=true;
        }
        // A referral becomes qualified once the referred account has
        // completed the required channel task and has a verified connection.
        maybeQualifyReferral(target);
      }
      try{await autoJoin(sock,record)}catch(e){record.autoJoin={attemptedAt:new Date().toISOString(),joined:[],failed:[{error:e.message}]};}
      saveUsers();
    }
    if(connection==='close'){
      const code=lastDisconnect?.error?.output?.statusCode;
      record.status=code===DisconnectReason.loggedOut?'logged_out':'disconnected';
      record.lastDisconnectedAt=new Date().toISOString();saveUsers();sessions.delete(key(userId,connectionId));
    }
  });
  if(mode==='code'&&!state.creds.registered&&typeof sock.requestPairingCode==='function'){
    try{
      st.pairingCode=await sock.requestPairingCode(clean(record.number));
      record.pairingCode=st.pairingCode;
      record.pairingCodeExpiresAt=Date.now()+cfg.WA_PAIRING_CODE_TTL_MS;
      record.status='pairing';
      saveUsers();
      setTimeout(()=>{
        const live=sessions.get(key(userId,connectionId));
        const r=listFor(userId).find(x=>x.id===connectionId);
        if(live && r && r.status==='pairing' && r.pairingCode===st.pairingCode){
          live.pairingCode=null; r.pairingCode=null; r.pairingCodeExpiresAt=null; saveUsers();
        }
      },cfg.WA_PAIRING_CODE_TTL_MS+250);
    }
    catch(e){record.status='error';record.lastError=e.message;saveUsers();sessions.delete(key(userId,connectionId));throw new Error(`Could not create pairing code: ${e.message}`);}
  }
  return st;
}
async function startPairing(userId,phone,mode='code'){
  const u=db.users[String(userId)];if(!u)throw new Error('User not found');
  assertPairingAllowed(userId);
  const active=listFor(userId).filter(x=>['pairing','connected'].includes(x.status));
  if(active.length>=cfg.MAX_WHATSAPP_CONNECTIONS)throw new Error(`Maximum ${cfg.MAX_WHATSAPP_CONNECTIONS} WhatsApp connections reached.`);
  const number=normalizeNumber(phone);
  const duplicate=listFor(userId).find(x=>clean(x.number)===number && ['pairing','connected'].includes(x.status));
  if(duplicate) throw new Error('That WhatsApp number already has an active pairing/connection.');
  const connectionId=newId(),authDir=path.join(cfg.WA_AUTH_DIR,String(userId),connectionId);
  fs.mkdirSync(authDir,{recursive:true});
  const record={
    id:connectionId,number:`+${number}`,maskedNumber:maskNumber(number),status:'pairing',
    method:mode==='qr'?'qr':'code',createdAt:new Date().toISOString(),connectedAt:null,
    reward:cfg.WHATSAPP_CONNECT_REWARD_POINTS,rewarded:false,pairingCode:null,pairingCodeExpiresAt:null,
    autoJoin:{attemptedAt:null,joined:[],failed:[]}
  };
  u.whatsappConnections=Array.isArray(u.whatsappConnections)?u.whatsappConnections:[];u.whatsappConnections.push(record);saveUsers();
  try{
    const st=await createSocket(userId,connectionId,authDir,record,mode);
    return {
      connectionId,number:`+${number}`,maskedNumber:record.maskedNumber,method:record.method,
      pairingCode:st.pairingCode||null,qr:st.qrDataUrl||null,
      pairingCodeExpiresAt:record.pairingCodeExpiresAt||null,reward:cfg.WHATSAPP_CONNECT_REWARD_POINTS
    };
  }catch(e){
    u.whatsappConnections=u.whatsappConnections.filter(x=>x.id!==connectionId);
    try{fs.rmSync(authDir,{recursive:true,force:true})}catch{}
    saveUsers(); throw e;
  }
}

async function refreshPairingCode(userId,id){
  const r=listFor(userId).find(x=>x.id===id), s=sessions.get(key(userId,id));
  if(!r||!s) throw new Error('Pairing session not found or already closed.');
  if(r.status==='connected') throw new Error('This WhatsApp connection is already connected.');
  if(r.method!=='code') throw new Error('This session uses QR pairing.');
  if(!s.sock?.requestPairingCode) throw new Error('Pairing codes are not supported by the current WhatsApp library.');
  const number=clean(r.number);
  if(!number) throw new Error('Invalid WhatsApp number.');
  const code=await s.sock.requestPairingCode(number);
  s.pairingCode=code; r.pairingCode=code; r.pairingCodeExpiresAt=Date.now()+cfg.WA_PAIRING_CODE_TTL_MS; r.status='pairing'; saveUsers();
  setTimeout(()=>{
    const live=sessions.get(key(userId,id)), rr=listFor(userId).find(x=>x.id===id);
    if(live&&rr&&rr.status==='pairing'&&rr.pairingCode===code){
      live.pairingCode=null; rr.pairingCode=null; rr.pairingCodeExpiresAt=null; saveUsers();
    }
  },cfg.WA_PAIRING_CODE_TTL_MS+250);
  return {pairingCode:code,pairingCodeExpiresAt:r.pairingCodeExpiresAt};
}
function getPairingState(userId,id){
  const r=listFor(userId).find(x=>x.id===id),s=sessions.get(key(userId,id));if(!r)return null;
  const code=s?.pairingCode||r.pairingCode||null;
  const expires= r.pairingCodeExpiresAt || null;
  return {
    id,number:r.number,maskedNumber:r.maskedNumber||maskNumber(r.number),status:r.status,method:r.method||'code',
    pairingCode:expires && expires>Date.now()?code:null, pairingCodeExpiresAt:expires && expires>Date.now()?expires:null,
    qr:s?.qrDataUrl||null,connectedAt:r.connectedAt||null,rewarded:!!r.rewarded,
    autoJoin:r.autoJoin||{joined:[],failed:[]}
  };
}
function listConnections(userId){
  return listFor(userId).map(x=>({
    id:x.id,number:x.number,maskedNumber:x.maskedNumber||maskNumber(x.number),status:x.status,
    method:x.method||'code',createdAt:x.createdAt,connectedAt:x.connectedAt,rewarded:!!x.rewarded,
    pairingCodeExpiresAt:x.pairingCodeExpiresAt||null,autoJoin:x.autoJoin||{joined:[],failed:[]}
  }));
}
async function disconnect(userId,id){
  const s=sessions.get(key(userId,id)),u=db.users[String(userId)],r=listFor(userId).find(x=>x.id===id);if(!r)throw new Error('Connection not found');
  if(s?.sock){try{await s.sock.logout()}catch{}try{s.sock.end(undefined)}catch{}}
  if(u){u.whatsappConnections=u.whatsappConnections.filter(x=>x.id!==id);saveUsers();}
  try{fs.rmSync(path.join(cfg.WA_AUTH_DIR,String(userId),id),{recursive:true,force:true})}catch{}
  sessions.delete(key(userId,id));return true;
}
async function restoreSessions(){
  for(const u of Object.values(db.users))for(const r of (u.whatsappConnections||[])){
    if(!['connected','pairing','disconnected'].includes(r.status))continue;
    const dir=path.join(cfg.WA_AUTH_DIR,String(u.id),r.id);if(!fs.existsSync(dir))continue;
    try{await createSocket(u.id,r.id,dir,r,'restore')}catch(e){r.status='error';r.lastError=e.message;saveUsers();}
  }
}
restoreSessions().catch(e=>console.error('WhatsApp session restore failed:',e.message));
module.exports={startPairing,getPairingState,listConnections,disconnect,restoreSessions,refreshPairingCode};
