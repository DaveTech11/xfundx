require('dotenv').config();
const { Bot, RichMessage } = require('ayotbl');
const cfg = require('./config');
const { db, saveUsers, saveWithdrawals, saveAudit } = require('./store');
const { ensureUser, ngnFromPoints, referralCode, maybeQualifyReferral, award, claimVideo, claimDaily, claimMission, missionStatus } = require('./rewards');
const { checkChannelMembership } = require('./telegram');
const social = require('./socialProof');

if (!cfg.BOT_TOKEN || cfg.BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') {
  console.error('❌ Set BOT_TOKEN in .env'); process.exit(1);
}

const bot = new Bot(cfg.BOT_TOKEN, { floodControl: { maxRetries: 5 }, minIntervalMs: 35 });
const isAdmin = id => Number(id) === cfg.ADMIN_ID;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const money = p => `₦${ngnFromPoints(p).toFixed(2)}`;
const pendingInput = new Map();

function keyboard(rows) {
  return { inline_keyboard: rows.map(row => row.map(b => {
    if (b.url) return { text:b.text, url:b.url };
    if (b.webApp) return { text:b.text, web_app:b.webApp };
    return { text:b.text, callback_data:b.callback_data, ...(b.style ? {style:b.style} : {}) };
  })) };
}

function menu(id) {
  const rows = [
    [{text:'🌐 σρєη χfυη∂ѕ', webApp:{url:cfg.APP_URL}}],
    [{text:'🎬 νι∂єσѕ', webApp:{url:`${cfg.APP_URL}/videos`}}],
    [{text:'🎯 ¢ℓαιм ρσιηтѕ',callback_data:'earn'},{text:'💰 вαℓαη¢є',callback_data:'balance'}],
    [{text:'📣 ¢нαηηєℓ тαѕк',callback_data:'channels'},{text:'▶️ уσυтυвє',callback_data:'youtube'}],
    [{text:'🎵 тιктσк',callback_data:'tiktok'}],
    [{text:'🔥 ∂αιℓу ¢нє¢к-ιη',callback_data:'daily'}],
    [{text:'📱 ωнαтѕαρρ',callback_data:'whatsapp'},{text:'🏦 вαηк / ραуσυт',callback_data:'bank'}],
    [{text:'💸 ωιтн∂яαω',callback_data:'withdraw'},{text:'🤝 яєfєяяαℓ',callback_data:'referral'}],
    [{text:'🏆 ℓєα∂єявσαя∂',callback_data:'leaderboard'},{text:'📜 яєωαя∂ нιѕтσяу',callback_data:'history'}],
    [{text:'👤 ρяσfιℓє',callback_data:'profile'},{text:'ℹ️ нєℓρ',callback_data:'help'}]
  ];
  if (isAdmin(id)) rows.push([{text:'🛡 α∂мιη ραηєℓ',callback_data:'admin'}]);
  return keyboard(rows);
}

function videoRich() {
  const lines = cfg.VIDEO_TASKS.map(v => `• **${v.title}** — +${v.reward} pts`).join('\n') || 'No videos configured yet.';
  return RichMessage.markdown()
    .heading('🎬 Xfunds Video Center', 2)
    .text('Watch the available videos in the web app. Each video can be claimed once after the watch timer is completed.')
    .text(lines)
    .build();
}

async function showVideoCenter(ctx) {
  const kb = keyboard([
    [{text:'🎬 WATCH VIDEOS', webApp:{url:`${cfg.APP_URL}/videos`}}],
    [{text:'📱 CONNECT WHATSAPP', webApp:{url:`${cfg.APP_URL}/whatsapp`}}],
    [{text:'⬅️ MAIN MENU',callback_data:'home'}]
  ]);
  return ctx.replyRich(videoRich(), {reply_markup:kb});
}

async function showEarnCenter(ctx,u) {
  const membership = await checkChannelMembership(u.id).catch(() => ({complete:false}));
  const videosDone = Object.keys(u.videoClaims || {}).length;
  const videosTotal = cfg.VIDEO_TASKS.length;
  const waActive = (u.whatsappConnections || []).filter(x => ['pairing','connected'].includes(x.status)).length;
  const today = new Date().toISOString().slice(0,10); const dailyCount = u.dailyClaims?.date === today ? Number(u.dailyClaims.count || 0) : 0; const dailyLimit = u.vip ? cfg.VIP_DAILY_CLAIMS : 1; const dailyAvailable = dailyCount < dailyLimit;
  const referralReward = cfg.REFERRAL_REWARD_POINTS;
  const rows = [
    [{text:`📣 CHANNELS • ${membership.complete ? 'DONE' : 'AVAILABLE'} +${cfg.POINTS_PER_TASK}`,callback_data:'channels'}],
    [{text:`▶️ YOUTUBE • ${u.youtubeTask?.status === 'approved' ? 'DONE' : 'AVAILABLE'} +${cfg.YOUTUBE_TASK_REWARD}`,callback_data:'youtube'}],
    [{text:`🎵 TIKTOK • ${u.tiktokTask?.status === 'approved' ? 'DONE' : 'AVAILABLE'} +${cfg.TIKTOK_TASK_REWARD}`,callback_data:'tiktok'}],
    [{text:`🎬 VIDEOS • ${videosDone}/${videosTotal} DONE`,webApp:{url:`${cfg.APP_URL}/videos`}}],
    [{text:`📱 WHATSAPP • ${waActive}/${cfg.MAX_WHATSAPP_CONNECTIONS}`,webApp:{url:`${cfg.APP_URL}/whatsapp`}}],
    [{text:`🔥 DAILY • ${dailyAvailable ? `+${cfg.DAILY_REWARD_POINTS} (${dailyCount}/${dailyLimit})` : 'CLAIMED'}`,callback_data:'daily'}],
    [{text:`🤝 REFERRALS • +${referralReward} EACH`,callback_data:'referral'}],
    [{text:'🏆 LEADERBOARD',callback_data:'leaderboard'},{text:'👤 PROFILE',callback_data:'profile'}],
    [{text:'⬅️ MAIN MENU',callback_data:'home'}]
  ];
  const totalVideo = cfg.VIDEO_TASKS.filter(v => !u.videoClaims?.[v.id]).reduce((n,v)=>n+Number(v.reward||0),0);
  const available = (membership.complete && !u.taskClaims?.channels ? cfg.POINTS_PER_TASK : 0) + totalVideo + (dailyAvailable ? cfg.DAILY_REWARD_POINTS : 0) + Math.max(0,cfg.MAX_WHATSAPP_CONNECTIONS-waActive)*cfg.WHATSAPP_CONNECT_REWARD_POINTS;
  return ctx.reply(`<b>💰 XFUNDS EARN CENTER</b>\n\n🎬 Videos: <b>${videosDone}/${videosTotal}</b> completed\n📱 WhatsApp: <b>${waActive}/${cfg.MAX_WHATSAPP_CONNECTIONS}</b> connections\n📣 Channel task: <b>${membership.complete ? 'completed' : 'available'}</b>\n🔥 Daily check-in: <b>${dailyAvailable ? 'available' : 'claimed'}</b>\n👥 Qualified referrals: <b>${u.qualifiedReferrals||0}</b>\n\n<b>Available reward potential:</b> +${available.toLocaleString()} pts\n\nChoose an earning method below.`,{parse_mode:'HTML',reply_markup:keyboard(rows)});
}

async function showTasks(ctx, u) {
  const membership = await checkChannelMembership(u.id).catch(() => ({complete:false,channels:[]}));
  const channelState = membership.complete ? '✅ Ready to claim' : '❌ Join all required channels';
  const yt = social.getState(u, 'youtube');
  const tk = social.getState(u, 'tiktok');
  const waState = u.whatsapp?.status === 'verified' ? '✅ Verified' : u.whatsapp?.status === 'pending' ? '⏳ Pending' : '❌ Not linked';
  const videoCount = Object.keys(u.videoClaims || {}).length;
  const totalVideos = cfg.VIDEO_TASKS.length;
  const today = new Date().toISOString().slice(0,10); const dailyCount = u.dailyClaims?.date === today ? Number(u.dailyClaims.count || 0) : 0; const dailyLimit = u.vip ? cfg.VIP_DAILY_CLAIMS : 1; const dailyState = dailyCount >= dailyLimit ? '✅ Limit reached' : `🔥 Available (${dailyCount}/${dailyLimit})`;
  const missions = missionStatus(u);
  const claimable = missions.filter(m=>m.claimable);
  const missionLines = missions.map(m => `${m.completed ? '✅' : m.claimable ? '🎁' : '▫️'} ${esc(m.title)} — +${m.reward} pts (${m.progress.toLocaleString()}/${m.goal.toLocaleString()})`).join('\n');
  const missionButtons = claimable.slice(0,6).map(m=>[{text:`🎁 CLAIM +${m.reward}`,callback_data:`mission:${m.id}`}]);
  return ctx.reply(
    `<b>🎯 Xfunds Professional Tasks</b>\n\n`+
    `📣 Channels: <b>${channelState}</b> — +${cfg.POINTS_PER_TASK} pts\n`+
    `▶️ YouTube: <b>${esc(yt.status)}</b> — +${cfg.YOUTUBE_TASK_REWARD} pts\n`+
    `🎵 TikTok: <b>${esc(tk.status)}</b> — +${cfg.TIKTOK_TASK_REWARD} pts\n`+
    `📱 WhatsApp: <b>${waState}</b>\n`+
    `🎬 Videos: <b>${videoCount}/${totalVideos} claimed</b>\n`+
    `🔥 Daily: <b>${dailyState}</b> — +${cfg.DAILY_REWARD_POINTS} pts/claim${u.vip ? ` • VIP ${dailyLimit}x/day` : ' • 1x/day'}\n\n`+
    `<b>⭐ Milestone Missions</b>\n${missionLines || 'No missions configured.'}\n\n`+
    `<i>Complete milestones naturally, then claim each bonus once.</i>`,
    {parse_mode:'HTML',reply_markup:keyboard([
      [{text:'📣 JOIN & VERIFY',callback_data:'channels'},{text:'▶️ YOUTUBE',callback_data:'youtube'}],
      [{text:'🎵 TIKTOK',callback_data:'tiktok'}],
      [{text:'🎬 WATCH VIDEOS',webApp:{url:`${cfg.APP_URL}/videos`}},{text:'📱 WHATSAPP',webApp:{url:`${cfg.APP_URL}/whatsapp`}}],
      [{text:'🔥 CLAIM DAILY',callback_data:'daily'}],
      ...missionButtons,
      [{text:'🔄 REFRESH TASKS',callback_data:'tasks'}],
      [{text:'⬅️ MAIN MENU',callback_data:'home'}]
    ])}
  );
}

async function showLeaderboard(ctx) {
  const users = Object.values(db.users).sort((a,b) => Number(b.lifetimePoints || 0) - Number(a.lifetimePoints || 0));
  const top = users.slice(0,10);
  const mine = users.findIndex(u => String(u.id) === String(ctx.from.id)) + 1;
  const lines = top.length ? top.map((u,i)=>`${i<3?['🥇','🥈','🥉'][i]:`#${i+1}`} <b>${esc(u.firstName || u.username || `User ${u.id}`)}</b> — ${Number(u.lifetimePoints||0).toLocaleString()} pts`).join('\n') : 'No rankings yet.';
  return ctx.reply(`<b>🏆 Xfunds Leaderboard</b>\n\n${lines}\n\nYour rank: <b>#${mine || '—'}</b>`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'🔄 REFRESH',callback_data:'leaderboard'}],[{text:'⬅️ MAIN MENU',callback_data:'home'}]])});
}

async function showHistory(ctx,u) {
  const logs = Array.isArray(u.rewardLog) ? u.rewardLog.slice(-10).reverse() : [];
  const lines = logs.length ? logs.map(x=>`• <b>+${Number(x.amount).toLocaleString()} pts</b> — ${esc(String(x.reason).replace(/^video:/,'Video '))}\n  <i>${new Date(x.at).toLocaleString()}</i>`).join('\n') : 'No rewards yet.';
  return ctx.reply(`<b>📜 Reward History</b>\n\n${lines}`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'⬅️ MAIN MENU',callback_data:'home'}]])});
}

async function showProfile(ctx,u) {
  const activeWa = (u.whatsappConnections||[]).filter(x=>['pairing','connected'].includes(x.status)).length;
  return ctx.reply(`<b>👤 Your Xfunds Profile</b>\n\n⭐ VIP: <b>${u.vip?'ACTIVE':'NORMAL'}</b>\nName: <b>${esc(u.firstName || 'User')}</b>\nUsername: ${u.username ? '@'+esc(u.username) : '—'}\nBalance: <b>${Number(u.points||0).toLocaleString()} pts</b>\nLifetime: <b>${Number(u.lifetimePoints||0).toLocaleString()} pts</b>\nVideos claimed: <b>${Object.keys(u.videoClaims||{}).length}</b>\nWhatsApp: <b>${activeWa}/${cfg.MAX_WHATSAPP_CONNECTIONS}</b>\nDaily streak: <b>${Number(u.checkInStreak||0)} day(s)</b>\nReferrals: <b>${Number(u.qualifiedReferrals||0)}</b>`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'📜 HISTORY',callback_data:'history'},{text:'🏆 RANK',callback_data:'leaderboard'}],[{text:'⬅️ MAIN MENU',callback_data:'home'}]])});
}

bot.command("start", async (ctx) => {
  const u = ensureUser(ctx.from, ctx.text?.split(/\s+/).slice(1).join(' ') || null);
  return ctx.replyRich(
    RichMessage.markdown()
      .heading('💎 Xfunds Rewards', 2)
      .text(`Hello ${u.firstName || 'there'} 👋`)
      .text('Complete tasks, watch videos, connect your own WhatsApp account with Baileys, and earn points.')
      .text(`🎬 ${cfg.VIDEO_TASKS.length} video tasks • +${cfg.POINTS_PER_VIDEO} pts each`)
      .text(`📱 WhatsApp connections • +${cfg.WHATSAPP_CONNECT_REWARD_POINTS} pts each • max ${cfg.MAX_WHATSAPP_CONNECTIONS}`)
      .build(),
    {reply_markup:menu(ctx.from.id)}
  );
});

bot.command("tasks", ctx => showTasks(ctx, ensureUser(ctx.from)));
bot.command("earn", ctx => showEarnCenter(ctx, ensureUser(ctx.from)));
bot.command("claim", ctx => showEarnCenter(ctx, ensureUser(ctx.from)));

bot.action(/^earn$/, async ctx => { await ctx.answerCbQuery(); return showEarnCenter(ctx, ensureUser(ctx.from)); });

bot.command("balance", ctx => {
  const u=ensureUser(ctx.from);
  return ctx.reply(`💰 <b>${u.points.toLocaleString()} points</b>\n≈ <b>${money(u.points)}</b>`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

async function handleChannels(ctx,u) {
  const check=await checkChannelMembership(u.id).catch(()=>({complete:false,channels:[]}));
  const status=check.channels?.length ? check.channels.map(c=>`${c.joined?'✅':'❌'} ${esc(c.channel)}`).join('\n') : '⚠️ Channel configuration unavailable.';
  const rows = cfg.REQUIRED_CHANNELS.map((c,i)=>[{text:`📢 Join channel ${i+1}`,url:`https://t.me/${c.replace(/^@/,'')}`}]);
  rows.push([{text:'🔄 VERIFY',callback_data:'channels_verify'}],[{text:'⬅️ BACK',callback_data:'tasks'}]);
  return ctx.reply(`<b>📣 Join all required channels</b>\n\n${status}\n\nStay joined to keep withdrawal eligibility.`,{parse_mode:'HTML',reply_markup:keyboard(rows)});
}

async function handleWithdraw(ctx,u) {
  const membership=await checkChannelMembership(u.id).catch(()=>({complete:false}));
  if (!membership.complete) return ctx.reply('❌ You must currently be a member of all required channels before payment can be requested.',{reply_markup:menu(u.id)});
  if (u.bank?.status!=='verified') return ctx.reply('🏦 Your bank account is not verified yet. Add it on the website, then return here.',{reply_markup:menu(u.id)});
  const withdrawMin = u.vip ? cfg.VIP_WITHDRAW_MIN_POINTS : cfg.WITHDRAW_MIN_POINTS;
  if (u.points < withdrawMin) return ctx.reply(`💸 ${u.vip?'VIP':'Normal'} withdrawal minimum is ${withdrawMin} points (${money(withdrawMin)}).\n\nYour balance: ${u.points.toLocaleString()} points.`,{reply_markup:menu(u.id)});
  return ctx.reply(`💸 <b>Payment / Withdrawal</b>\n\nAvailable: <b>${u.points.toLocaleString()} points</b> (${money(u.points)})\nMinimum: <b>${withdrawMin.toLocaleString()} points</b>\nMaximum: <b>${cfg.WITHDRAW_MAX_POINTS.toLocaleString()} points</b> (${money(cfg.WITHDRAW_MAX_POINTS)})`,{parse_mode:'HTML',reply_markup:keyboard([
    [{text:`${u.vip ? Math.min(cfg.WITHDRAW_MAX_POINTS,u.points) : cfg.WITHDRAW_MIN_POINTS} points`,callback_data:`withdraw_amount:${u.vip ? Math.min(cfg.WITHDRAW_MAX_POINTS,u.points) : cfg.WITHDRAW_MIN_POINTS}`}],
    [{text:'🌐 OPEN PAYOUT PAGE',webApp:{url:cfg.APP_URL}}],
    [{text:'⬅️ BACK',callback_data:'home'}]
  ])});
}

bot.command("withdraw", ctx => handleWithdraw(ctx, ensureUser(ctx.from)));

bot.action(/^home$/, async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply('💎 <b>Xfunds Main Menu</b>',{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});
bot.action(/^mission:(.+)$/, async ctx => {
  await ctx.answerCbQuery();
  const u = ensureUser(ctx.from);
  const mission = missionStatus(u).find(m=>m.id===ctx.match[1]);
  if (!mission) return ctx.reply('❌ Mission not found.');
  if (!mission.claimable) return ctx.reply(`⏳ <b>${esc(mission.title)}</b> is not ready yet.\nProgress: ${mission.progress}/${mission.goal}`,{parse_mode:'HTML'});
  const rewarded = claimMission(u, mission.id, mission.reward);
  return ctx.reply(rewarded ? `🎉 <b>Mission complete!</b>\n+${mission.reward.toLocaleString()} points added.\n\n💰 Balance: ${u.points.toLocaleString()} pts` : '⚠️ This mission was already claimed.',{parse_mode:'HTML',reply_markup:keyboard([[{text:'🎯 TASKS',callback_data:'tasks'}],[{text:'⬅️ MAIN MENU',callback_data:'home'}]])});
});

bot.action(/^tasks$/, async ctx => { await ctx.answerCbQuery(); return showTasks(ctx,ensureUser(ctx.from)); });
bot.action(/^balance$/, async ctx => {
  await ctx.answerCbQuery(); const u=ensureUser(ctx.from);
  return ctx.reply(`💰 <b>${u.points.toLocaleString()} points</b>\n≈ <b>${money(u.points)}</b>\n\nLifetime: ${u.lifetimePoints.toLocaleString()} points`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});
bot.action(/^videos$/, async ctx => { await ctx.answerCbQuery(); return showVideoCenter(ctx); });
bot.action(/^channels$/, async ctx => { await ctx.answerCbQuery(); return handleChannels(ctx,ensureUser(ctx.from)); });

bot.action(/^channels_verify$/, async ctx => {
  await ctx.answerCbQuery();
  const u=ensureUser(ctx.from);
  const check=await checkChannelMembership(u.id).catch(()=>({complete:false,channels:[]}));
  if (!check.complete) return ctx.reply(`❌ Not complete yet.\n\n${check.channels.map(c=>`${c.joined?'✅':'❌'} ${esc(c.channel)}`).join('\n')}`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'🔄 CHECK AGAIN',callback_data:'channels_verify'}],[{text:'⬅️ BACK',callback_data:'channels'}]])});
  const rewarded=award(u,cfg.POINTS_PER_TASK,'channels'); maybeQualifyReferral(u);
  return ctx.reply(rewarded?`🎉 <b>+${cfg.POINTS_PER_TASK} points!</b>\n\nChannel task completed.`:'✅ Channel reward was already claimed.',{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

// Generalized YouTube + TikTok follow/join + screenshot proof flow.
// Supports 2 YouTube channels and 3 TikTok accounts (or any configured slots).
const SOCIAL_LABEL = { youtube: 'YouTube', tiktok: 'TikTok' };
const socialIds = () => Object.keys(social.PLATFORMS);
function socialBase(id){ return social.PLATFORMS[id]?.platform || (id.startsWith('youtube') ? 'youtube' : 'tiktok'); }
function socialLabel(id){ return SOCIAL_LABEL[socialBase(id)] || id; }
function socialProofCallback(id){ return `${id}_proof`; }

bot.action(/^(youtube(?:_[12])?|tiktok(?:_[123])?)$/, async ctx => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  if (!social.PLATFORMS[id]) return ctx.reply('⚠️ This social task is not configured.');
  const u = ensureUser(ctx.from);
  const task = social.getTask(id), state = social.getState(u,id), platform = socialBase(id);
  const status = state.status === 'approved' ? '✅ Completed' : state.status === 'pending' ? '⏳ Proof under review' : state.status === 'rejected' ? '❌ Proof rejected — send a clearer screenshot' : '🟡 Not submitted';
  return ctx.reply(`<b>${platform === 'youtube' ? '▶️' : '🎵'} ${esc(task.title)}</b>\n\n${platform === 'youtube' ? 'Join/subscribe to' : 'Follow'} <b>${esc(task.accountName)}</b> on ${socialLabel(id)}.\nReward: <b>+${task.reward} points</b>\nStatus: <b>${status}</b>\n\nAfter ${platform === 'youtube' ? 'joining' : 'following'}, tap <b>SEND PROOF</b> and send a clear screenshot.`, { parse_mode:'HTML', reply_markup:keyboard([
    [{text:`${platform === 'youtube' ? '▶️' : '🎵'} OPEN ${socialLabel(id).toUpperCase()}`,url:task.url}],
    [{text:'🧾 SEND PROOF',callback_data:socialProofCallback(id)}],
    [{text:'⬅️ TASKS',callback_data:'tasks'}]
  ])});
});

bot.action(/^(youtube(?:_[12])?|tiktok(?:_[123])?)_proof$/, async ctx => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  if (!social.PLATFORMS[id]) return ctx.reply('⚠️ This social task is not configured.');
  const u = ensureUser(ctx.from), state = social.getState(u,id);
  if (state.status === 'approved') return ctx.reply(`✅ This ${socialLabel(id)} task is already completed.`, {reply_markup:menu(ctx.from.id)});
  if (state.status === 'pending') return ctx.reply('⏳ Your previous screenshot is already under review. Please wait for the result.');
  pendingInput.set(u.id, `${id}_proof`);
  return ctx.reply(`🧾 <b>Send your proof screenshot now.</b>\n\nThe screenshot must clearly show the correct ${socialLabel(id)} account and your followed/subscribed state.`, {parse_mode:'HTML', reply_markup:keyboard([[{text:'❌ CANCEL',callback_data:id}]])});
});

bot.action(/^soc_ok:(youtube(?:_[12])?|tiktok(?:_[123])?):(\d+)$/, async ctx => {
  await ctx.answerCbQuery(); if (!isAdmin(ctx.from.id)) return;
  const id = ctx.match[1], target = db.users[String(ctx.match[2])];
  if (!target || !social.PLATFORMS[id]) return ctx.reply('User/task not found.');
  const task=social.getTask(id), rewarded=social.approve(target,id);
  db.audit=db.audit||[]; db.audit.push({id:`AUD-${Date.now()}`,action:'social_approve',actorId:ctx.from.id,at:new Date().toISOString(),details:{platform:id,userId:target.id,rewarded}}); saveAudit();
  bot.api.sendMessage({chat_id:target.id,text:rewarded ? `🎉 <b>${esc(task.title)} proof approved!</b>\n+${task.reward} points added.` : `⚠️ Proof was already processed.`,parse_mode:'HTML',reply_markup:menu(target.id)}).catch(()=>{});
  return ctx.reply(rewarded ? '✅ Approved and rewarded.' : '⚠️ Already processed.');
});

bot.action(/^soc_no:(youtube(?:_[12])?|tiktok(?:_[123])?):(\d+)$/, async ctx => {
  await ctx.answerCbQuery(); if (!isAdmin(ctx.from.id)) return;
  const id=ctx.match[1], target=db.users[String(ctx.match[2])];
  if (!target || !social.PLATFORMS[id]) return ctx.reply('User/task not found.');
  social.reject(target,id); db.audit=db.audit||[]; db.audit.push({id:`AUD-${Date.now()}`,action:'social_reject',actorId:ctx.from.id,at:new Date().toISOString(),details:{platform:id,userId:target.id}}); saveAudit();
  bot.api.sendMessage({chat_id:target.id,text:`❌ <b>${esc(social.getTask(id).title)} proof rejected.</b>\nPlease complete the correct account task and send a clearer screenshot.`,parse_mode:'HTML',reply_markup:keyboard([[{text:'▶️ TRY AGAIN',callback_data:id}],[{text:'⬅️ TASKS',callback_data:'tasks'}]])}).catch(()=>{});
  return ctx.reply('❌ Proof rejected.');
});

bot.action(/^daily$/, async ctx => {
  await ctx.answerCbQuery(); const u=ensureUser(ctx.from); const rewarded=claimDaily(u);
  const today=new Date().toISOString().slice(0,10); const count=u.dailyClaims?.date===today?Number(u.dailyClaims.count||0):0; const limit=u.vip?cfg.VIP_DAILY_CLAIMS:1; return ctx.reply(rewarded?`🔥 <b>+${cfg.DAILY_REWARD_POINTS} points!</b>\nDaily reward claimed.\n\nClaims today: <b>${count}/${limit}</b>`:`⏳ You have used all ${limit} daily claim${limit===1?'':'s'} for today.`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

bot.action(/^video$/, async ctx => { await ctx.answerCbQuery(); return showVideoCenter(ctx); });

bot.action(/^whatsapp$/, async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply(`📱 <b>WhatsApp pairing</b>\n\nConnect only a WhatsApp number you own with Baileys. Each successfully connected account earns <b>+${cfg.WHATSAPP_CONNECT_REWARD_POINTS} points</b>.\n\nMaximum active connections: <b>${cfg.MAX_WHATSAPP_CONNECTIONS}</b>.`,{parse_mode:'HTML',reply_markup:keyboard([
    [{text:'📱 OPEN PAIRING',webApp:{url:`${cfg.APP_URL}/whatsapp`}}],
    [{text:'⬅️ BACK',callback_data:'tasks'}]
  ])});
});

bot.action(/^bank$/, async ctx => {
  await ctx.answerCbQuery(); const u=ensureUser(ctx.from);
  return ctx.reply(`🏦 <b>Bank / Payment</b>\n\nStatus: <b>${esc(u.bank?.status||'unverified')}</b>\n\nAdd your bank details on the website.`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'🏦 OPEN PAYOUT SETTINGS',webApp:{url:cfg.APP_URL}}],[{text:'💸 WITHDRAW',callback_data:'withdraw'}]])});
});

bot.action(/^withdraw$/, async ctx => { await ctx.answerCbQuery(); return handleWithdraw(ctx,ensureUser(ctx.from)); });

bot.action(/^withdraw_amount:(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const u=ensureUser(ctx.from); const points=Math.floor(Number(ctx.match[1]));
  const min = u.vip ? cfg.VIP_WITHDRAW_MIN_POINTS : cfg.WITHDRAW_MIN_POINTS; if (points<min || points>cfg.WITHDRAW_MAX_POINTS || points>u.points || (!u.vip && points!==cfg.WITHDRAW_MIN_POINTS) || u.bank?.status!=='verified') return handleWithdraw(ctx,u);
  const membership=await checkChannelMembership(u.id).catch(()=>({complete:false}));
  if(!membership.complete) return ctx.reply('❌ Rejoin all required channels before payment.',{reply_markup:menu(ctx.from.id)});
  const id=`WD-${Date.now()}-${require('crypto').randomBytes(2).toString('hex').toUpperCase()}`;
  u.points-=points; db.withdrawals[id]={id,userId:u.id,username:u.username,points,naira:ngnFromPoints(points),bank:{...u.bank},status:'pending',createdAt:new Date().toISOString()}; saveUsers(); saveWithdrawals();
  if(cfg.ADMIN_ID) bot.api.sendMessage({chat_id:cfg.ADMIN_ID,text:`💸 <b>New Xfunds payment request</b>\n\nID: <code>${id}</code>\nUser: ${u.username?'@'+esc(u.username):u.id}\nAmount: ${points.toLocaleString()} points = <b>${money(points)}</b>\nBank: ${esc(u.bank.bankName)}\nAccount: <code>${esc(u.bank.accountNumber)}</code>\nName: ${esc(u.bank.accountName)}`,parse_mode:'HTML',reply_markup:keyboard([[{text:'✅ Mark paid',callback_data:`wd_ok:${id}`},{text:'↩️ Reject + refund',callback_data:`wd_no:${id}`}]])}).catch(()=>{});
  return ctx.reply(`✅ <b>Payment request submitted</b>\n\nID: <code>${id}</code>\nAmount: ${money(points)}\nStatus: Pending admin payment.`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

bot.action(/^referral$/, async ctx => {
  await ctx.answerCbQuery(); const u=ensureUser(ctx.from); const code=referralCode(u.id);
  return ctx.reply(`🤝 <b>Referral</b>\n\nCode: <code>${esc(code)}</code>\nQualified referrals: <b>${u.qualifiedReferrals||0}</b>\nReward: <b>${cfg.REFERRAL_REWARD_POINTS} points</b> per qualified referral.`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

bot.action(/^leaderboard$/, async ctx => { await ctx.answerCbQuery(); return showLeaderboard(ctx); });
bot.action(/^history$/, async ctx => { await ctx.answerCbQuery(); return showHistory(ctx,ensureUser(ctx.from)); });
bot.action(/^profile$/, async ctx => { await ctx.answerCbQuery(); return showProfile(ctx,ensureUser(ctx.from)); });

bot.command('leaderboard', ctx => showLeaderboard(ctx));
bot.command('profile', ctx => showProfile(ctx,ensureUser(ctx.from)));
bot.command('history', ctx => showHistory(ctx,ensureUser(ctx.from)));

bot.action(/^help$/, async ctx => {
  await ctx.answerCbQuery();
  return ctx.reply(`ℹ️ <b>How Xfunds works</b>\n\n1. Join the required channels.\n2. Watch videos and claim each video once.\n3. Connect WhatsApp numbers you own; each successful connection can earn points up to the configured limit.\n4. Claim the daily check-in.\n5. Add a verified bank account and request payment.\n\n100 points = ₦${cfg.NGN_PER_100_POINTS.toFixed(2)}.`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

bot.command('vip', async ctx => {
  const u=ensureUser(ctx.from);
  const owner=cfg.VIP_OWNER_USERNAME ? `@${cfg.VIP_OWNER_USERNAME}` : 'the Xfunds owner';
  if(u.vip) return ctx.reply(`⭐ <b>VIP ACTIVE</b>\n\nYou can claim the daily reward up to <b>${cfg.VIP_DAILY_CLAIMS} times/day</b> and withdraw from <b>${cfg.VIP_WITHDRAW_MIN_POINTS} points</b>.`,{parse_mode:'HTML'});
  if(cfg.ADMIN_ID) bot.api.sendMessage({chat_id:cfg.ADMIN_ID,text:`⭐ <b>VIP ACCESS REQUEST</b>\n\nUser ID: <code>${u.id}</code>\nUsername: ${u.username?'@'+esc(u.username):'—'}\nName: ${esc(u.firstName||'User')}`,parse_mode:'HTML',reply_markup:keyboard([[{text:'⭐ GRANT VIP',callback_data:`vip_ok:${u.id}`},{text:'❌ REJECT',callback_data:`vip_no:${u.id}`}]])}).catch(()=>{});
  return ctx.reply(`⭐ <b>VIP ACCESS</b>\n\nDM <b>${owner}</b> and send your Telegram ID:\n<code>${u.id}</code>\n\nVIP users can claim the daily reward up to <b>${cfg.VIP_DAILY_CLAIMS} times per day</b> and withdraw from <b>${cfg.VIP_WITHDRAW_MIN_POINTS} points</b>.`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'⭐ REQUEST VIP',callback_data:'vip_request'}],[{text:'⬅️ MENU',callback_data:'home'}]])});
});

bot.action(/^vip_request$/, async ctx => {
  await ctx.answerCbQuery(); const u=ensureUser(ctx.from); const owner=cfg.VIP_OWNER_USERNAME ? `@${cfg.VIP_OWNER_USERNAME}` : 'the Xfunds owner';
  if(cfg.ADMIN_ID) bot.api.sendMessage({chat_id:cfg.ADMIN_ID,text:`⭐ VIP REQUEST\n\nUser ID: <code>${u.id}</code>\nUsername: ${u.username?'@'+esc(u.username):'—'}`,parse_mode:'HTML',reply_markup:keyboard([[{text:'⭐ GRANT VIP',callback_data:`vip_ok:${u.id}`},{text:'❌ REJECT',callback_data:`vip_no:${u.id}`}]])}).catch(()=>{});
  return ctx.reply(`📩 DM <b>${owner}</b> with ID <code>${u.id}</code>.`,{parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
});

bot.action(/^(vip_ok|vip_no):(\d+)$/, async ctx => {
  await ctx.answerCbQuery(); if(!isAdmin(ctx.from.id)) return; const act=ctx.match[1], id=ctx.match[2], target=db.users[id]; if(!target) return ctx.reply('User not found.');
  target.vip=act==='vip_ok'; saveUsers(); db.audit=db.audit||[]; db.audit.push({id:`AUD-${Date.now()}`,action:target.vip?'vip_granted':'vip_rejected',actorId:ctx.from.id,at:new Date().toISOString(),details:{userId:target.id}}); saveAudit();
  bot.api.sendMessage({chat_id:target.id,text:target.vip?`⭐ <b>VIP ACCESS GRANTED!</b>\n\nDaily reward: <b>${cfg.VIP_DAILY_CLAIMS} claims/day</b>\nVIP withdrawal minimum: <b>${cfg.VIP_WITHDRAW_MIN_POINTS} points</b>.`:`❌ <b>VIP request rejected.</b>`,parse_mode:'HTML',reply_markup:menu(target.id)}).catch(()=>{});
  return ctx.reply(target.vip?'⭐ VIP granted.':'❌ VIP request rejected.');
});

bot.action(/^admin$/, async ctx => {
  await ctx.answerCbQuery(); if(!isAdmin(ctx.from.id)) return;
  const pw=Object.values(db.withdrawals).filter(x=>x.status==='pending').length;
  const pb=Object.values(db.users).filter(x=>x.bank?.status==='pending').length;
  const pwa=Object.values(db.users).filter(x=>x.whatsapp?.status==='pending').length;
  return ctx.reply(`🛡 <b>Admin Panel</b>\n\nUsers: ${Object.keys(db.users).length}\nPending payments: ${pw}\nPending banks: ${pb}\nPending WhatsApp: ${pwa}`,{parse_mode:'HTML',reply_markup:keyboard([[{text:'🖥 OPEN WEB ADMIN',webApp:{url:`${cfg.APP_URL}/admin`}}],[{text:'⬅️ MENU',callback_data:'home'}]])});
});

bot.action(/^(bank_ok|bank_no):(.+)$/, async ctx => {
  await ctx.answerCbQuery(); if(!isAdmin(ctx.from.id)) return;
  const act=ctx.match[1], id=ctx.match[2], target=db.users[id]; if(!target?.bank)return;
  target.bank.status=act==='bank_ok'?'verified':'rejected'; target.bank.reviewedAt=new Date().toISOString(); saveUsers(); db.audit=db.audit||[]; db.audit.push({id:`AUD-${Date.now()}`,action:`bank_${act==='bank_ok'?'verified':'rejected'}`,actorId:ctx.from.id,at:new Date().toISOString(),details:{userId:target.id}}); saveAudit();
  bot.api.sendMessage({chat_id:target.id,text:act==='bank_ok'?'✅ Bank account verified. You can now request payment.':'❌ Bank verification rejected. Please update your details.'}).catch(()=>{});
  return ctx.reply(`Bank ${act==='bank_ok'?'verified':'rejected'}.`);
});

bot.action(/^(wa_ok|wa_no):(.+)$/, async ctx => {
  await ctx.answerCbQuery(); if(!isAdmin(ctx.from.id)) return;
  const act=ctx.match[1], id=ctx.match[2], target=db.users[id]; if(!target?.whatsapp)return;
  target.whatsapp.status=act==='wa_ok'?'verified':'rejected';
  if(act==='wa_ok') award(target,cfg.POINTS_PER_TASK,'whatsapp');
  maybeQualifyReferral(target); saveUsers(); db.audit=db.audit||[]; db.audit.push({id:`AUD-${Date.now()}`,action:`whatsapp_${act==='wa_ok'?'verified':'rejected'}`,actorId:ctx.from.id,at:new Date().toISOString(),details:{userId:target.id}}); saveAudit();
  bot.api.sendMessage({chat_id:target.id,text:act==='wa_ok'?`✅ WhatsApp verified. +${cfg.POINTS_PER_TASK} points.`:'❌ WhatsApp verification rejected.'}).catch(()=>{});
  return ctx.reply(`WhatsApp ${act==='wa_ok'?'verified':'rejected'}.`);
});

bot.action(/^(wd_ok|wd_no):(.+)$/, async ctx => {
  await ctx.answerCbQuery(); if(!isAdmin(ctx.from.id)) return;
  const act=ctx.match[1], id=ctx.match[2], wd=db.withdrawals[id]; if(!wd||wd.status!=='pending')return;
  const target=db.users[String(wd.userId)];
  if(act==='wd_ok') wd.status='paid';
  else { wd.status='rejected'; if(target){target.points+=wd.points;saveUsers();} }
  wd.processedAt=new Date().toISOString(); saveWithdrawals(); db.audit=db.audit||[]; db.audit.push({id:`AUD-${Date.now()}`,action:`withdrawal_${act==='wd_ok'?'paid':'rejected'}`,actorId:ctx.from.id,at:new Date().toISOString(),details:{id,userId:wd.userId,points:wd.points}}); saveAudit();
  bot.api.sendMessage({chat_id:wd.userId,text:act==='wd_ok'?`✅ Payment ${id} marked paid: ${money(wd.points)}.`:`↩️ Payment ${id} rejected and ${wd.points} points refunded.`}).catch(()=>{});
  return ctx.reply(act==='wd_ok'?'Marked paid.':'Rejected and refunded.');
});

bot.on('photo', async ctx => {
  const u = ensureUser(ctx.from);
  const mode = pendingInput.get(u.id);
  const platform = mode && mode.endsWith('_proof') ? mode.slice(0,-6) : null;
  if (!platform) return;
  pendingInput.delete(u.id);
  try {
    const photo = (ctx.photo || []).slice(-1)[0];
    if (!photo?.file_id) throw new Error('No image was received.');
    await ctx.reply('🔎 <b>Reviewing your proof…</b>', {parse_mode:'HTML'});
    const result = await social.submitTelegramPhoto(u, photo, cfg.ADMIN_ID, platform);
    if (result.status === 'approved') return ctx.reply(`🎉 <b>Proof accepted!</b>\n+${result.reward} points added.\n\n💰 Balance: ${u.points.toLocaleString()} pts`, {parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
    if (result.status === 'rejected') return ctx.reply(`❌ <b>Proof rejected.</b>\n${esc(result.message)}`, {parse_mode:'HTML',reply_markup:keyboard([[{text:'▶️ TRY AGAIN',callback_data:platform}],[{text:'⬅️ TASKS',callback_data:'tasks'}]])});
    return ctx.reply('⏳ <b>Proof received.</b>\nYour screenshot needs manual review. You will be notified after an admin decides.', {parse_mode:'HTML',reply_markup:menu(ctx.from.id)});
  } catch (e) {
    return ctx.reply(`❌ Could not process the screenshot: ${esc(e.message)}`, {parse_mode:'HTML',reply_markup:keyboard([[{text:'▶️ TRY AGAIN',callback_data:platform}]])});
  }
});

bot.on('text', async ctx => {
  const text=ctx.text || '';
  if(text.startsWith('/')) return;
  const u=ensureUser(ctx.from); const mode=pendingInput.get(u.id);
  if(mode==='whatsapp') {
    pendingInput.delete(u.id);
    return ctx.reply('📱 Use the pairing button to connect your WhatsApp with Baileys.',{reply_markup:keyboard([[{text:'📱 OPEN PAIRING',webApp:{url:`${cfg.APP_URL}/whatsapp`}}],[{text:'⬅️ MAIN MENU',callback_data:'home'}]])});
  }
});

console.log('🤖 Xfunds v5 bot using ayotbl + Bot API rich messaging');
Promise.resolve(bot.launch()).then(()=>console.log('🚀 Telegram polling started')).catch(err=>{console.error('❌ Bot failed:',err);process.exit(1);});
