# Xfunds v5 — Multi-video + Baileys + ayotbl

Xfunds v5 keeps the original rewards/payout flow and adds:

- A dedicated **Video Center** at `/videos`.
- Multiple independent video tasks. Each video has its own reward and can be claimed once.
- Server-side video timers so the claim endpoint does not trust a client-supplied watch time.
- A dedicated **WhatsApp Pairing** page at `/whatsapp`.
- Baileys pairing-code sessions for WhatsApp numbers the user owns/controls.
- A configurable maximum number of active WhatsApp connections.
- Points for each successfully connected WhatsApp session, with a configurable reward.
- Telegram bot migrated from `node-telegram-bot-api` to **ayotbl 0.2.4**.
- Rich Telegram video-center message using `RichMessage`, plus a **WATCH VIDEOS** Web App button.
- Main menu buttons for Videos and WhatsApp.

## Important WhatsApp note

Only allow users to connect WhatsApp numbers they own or are authorized to manage. Baileys authentication files are stored under `WA_AUTH_DIR`. On Render or another ephemeral filesystem, WhatsApp sessions will not survive a restart unless you attach persistent storage.

The connection reward is deliberately capped by `MAX_WHATSAPP_CONNECTIONS` to avoid unlimited reward farming.

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env`.
3. Set `BOT_TOKEN`, `ADMIN_ID`, `APP_URL`, and the required channels.
4. Add your real embeddable URLs to `VIDEO_1_URL`, `VIDEO_2_URL`, etc.
5. Set `MAX_WHATSAPP_CONNECTIONS` and `WHATSAPP_CONNECT_REWARD_POINTS`.
6. Start the website with `npm start`.
7. Start the Telegram bot with `npm run bot`.

Node.js 18+ is required by ayotbl; Node 20+ is recommended for this project.

## Video flow

Telegram → **🎬 VIDEOS** → Xfunds Video Center → choose a video → **Start task** → keep the task open for the configured number of seconds → **Claim reward**.

Each video has a separate claim record in `users.json`.

## WhatsApp flow

Telegram → **📱 WHATSAPP** → **OPEN PAIRING** → enter the international WhatsApp number → receive a Baileys pairing code → enter it in WhatsApp Linked Devices → when the connection opens, the configured reward is credited.

## Reward rules

- Channel task: `POINTS_PER_TASK`
- Each video: its `VIDEO_n_REWARD`
- Daily check-in: `POINTS_PER_TASK`
- Successful WhatsApp connection: `WHATSAPP_CONNECT_REWARD_POINTS`
- Referral reward: `REFERRAL_REWARD_POINTS`

The existing payout flow remains admin-reviewed; the project does not pretend to perform bank transfers automatically.


## v6-style additions in this build
- Bot leaderboard, profile, and reward history.
- Compact web quick-stats section for leaderboard and recent rewards.
- Daily check-in streak tracking without changing the existing +points reward logic.
- WhatsApp earning remains tied to a successful Baileys connection, with the configured per-user connection cap.


## v9 additions — TikTok, web join, and anti-bypass fixes

**Referral bug fix.** `checkChannelMembership()` previously required *exactly* 5 configured channels (`channels.length === 5`) before it would ever report membership as complete. If you had fewer than 5 real channels — or any placeholder/broken channel — the channel task, referral qualification, and withdrawals could never complete for anyone. This now works with however many channels are actually configured. Make sure every `REQUIRED_CHANNEL_n` in `.env` is either a real channel the bot can read membership for, or left blank — a placeholder value like `yourchannel4` will always fail.

**TikTok follow task.** Mirrors the existing YouTube task: follow the account, submit a screenshot, get reviewed by vision AI (if configured) or the admin, get rewarded. Configure `TIKTOK_ACCOUNT_URL`, `TIKTOK_ACCOUNT_NAME`, `TIKTOK_TASK_TITLE`, `TIKTOK_TASK_REWARD`. `youtubeProof.js` was replaced by `socialProof.js`, which handles both platforms from one module.

**Join from the web, no Telegram required.** Visiting the site directly (outside the Telegram Mini App) now issues a signed, anonymous session cookie and creates a normal account behind it — same points, tasks, and referral system as Telegram users. Set `WEB_SESSION_SECRET` in `.env` to a long random string in production, or sessions reset on every restart. Note: the Telegram-channel task still can't be completed by a pure web account, since there's no Telegram membership to check — that task remains Telegram-only by nature.

**Proof submission from the web too.** `POST /api/tasks/social/:platform/submit` accepts a base64 screenshot for the YouTube/TikTok tasks, so web-only users aren't limited to the Telegram bot's photo upload.

**Video watch anti-bypass.** The old video task trusted a raw elapsed-time check (`Date.now() - startedAt >= watchSeconds`), which is satisfied just by opening the task and walking away. It's replaced with a heartbeat: the player page pings the server every few seconds, but only while the browser tab is actually visible and focused. The claim endpoint now checks accumulated *active* watch seconds, not wall-clock time — switching tabs or minimizing pauses the count.

**Security note.** If the `.env` this project shipped with (containing a live `BOT_TOKEN` and `OPENAI_API_KEY`) has ever left your machine — uploaded, pasted, committed — treat both as compromised and rotate them (new bot token via @BotFather, new key from your OpenAI dashboard).


## v9 security/task upgrade

- Rate-limits social proof submissions and new web-only account cookie issuance.
- Stores hashed IP/device/user-agent signals for referral-farming detection; risky referrals do not qualify until reviewed.
- SHA-256 duplicate screenshot detection across YouTube/TikTok submissions.
- Adds `first_youtube` and `first_tiktok` missions.
- Adds per-video platform metadata (`VIDEO_N_PLATFORM=youtube|tiktok|generic`) and platform badges in Video Center.
- Adds Telegram-authenticated `/admin` web dashboard with withdrawal/proof review, user/risk lookup and audit log.
- Adds a lightweight arithmetic bot-check for new web sessions.
- Adds optional email OTP (SMTP) and phone OTP (Twilio); withdrawals require both when enabled.


## V10.1 traffic protection + daily reward emails

- Added global per-IP request limiting, request timeouts, small security headers, and disabled `X-Powered-By`.
- Added a daily reward email job. It sends one reminder per UTC day to users with a **verified email**.
- Default reminder time is 08:00 UTC (09:00 Nigeria/WAT).
- Configure SMTP plus `DAILY_REWARD_EMAIL_*` variables in Render.
- These protections improve resilience but no application can honestly guarantee that it is impossible to DDoS. For large attacks, use a CDN/WAF such as Cloudflare in front of the deployment and keep the origin protected.

## VIP + Withdrawal Rules (V11)
- Normal withdrawal threshold: 5,000 points.
- Normal users must request exactly 5,000 points; the request deducts the 5,000 points immediately, so the balance starts from 0 after a successful request. If admin rejects it, the points are refunded.
- VIP withdrawal minimum: 100 points; VIP maximum remains 5,000 points per request.
- Daily reward: 500 points.
- Normal users: 1 daily claim per UTC day.
- VIP users: up to 3 daily claims per UTC day.
- Users can request VIP access with `/vip`; the bot sends their Telegram ID to the owner/admin for approval.
- Admin can grant/remove VIP from the Telegram approval buttons or the web admin Users page.
- Set `VIP_OWNER_USERNAME` to the owner's Telegram username.

## V12 engagement + operations upgrade

Added: XP/levels, achievements, daily wheel, promo codes, weekly/monthly leaderboards, VIP Silver/Gold/Diamond tiers, admin analytics, user freeze/ban/clear controls, emergency withdrawal freeze, multiple admin IDs, and persistent system/promo data.

### VIP tiers
- Silver: 3 daily claims
- Gold: 4 daily claims
- Diamond: 5 daily claims
- VIP withdrawals start at 100 points
- Normal withdrawals remain exactly 5,000 points

### Admin
Use `/admin` in the Telegram Mini App context. Admin access accepts `ADMIN_ID` or comma-separated `ADMIN_IDS`.

## Social task configuration
V12 supports 2 YouTube follow/subscribe tasks and 3 TikTok follow tasks. Set YOUTUBE_1_URL/YOUTUBE_2_URL and TIKTOK_1_URL/TIKTOK_2_URL/TIKTOK_3_URL plus their names/rewards in Render Environment Variables. Each task has its own proof state, screenshot review, reward and anti-duplicate protection.


## WhatsApp sessions

Pair by code or QR. Authentication files are kept server-side under `WA_AUTH_DIR` and are never returned by the API. For production, use persistent storage at that path so sessions survive restarts/deploys. Configure only WhatsApp groups/channels you are authorized to join/follow with `WA_GROUP_INVITES` and `WA_CHANNEL_JIDS`. Keep `data/whatsapp-auth/` out of GitHub.


## V13.1 Rewards Center upgrade
- Wheel prizes can award actual cash balance or points.
- Daily scratch card, mystery box and streak milestone bonuses.
- Separate cash wallet and admin-reviewed cash withdrawals.
- Promo codes support points or cash rewards.
- Rewards Center UI exposes cash wallet and bonus games.
- Configure cash withdrawals with `CASH_WITHDRAW_MIN_NGN` and `CASH_WITHDRAW_MAX_NGN`.
- Set `CASH_WHEEL_ENABLED=false` to disable cash wheel prizes.

## xFunds V14 upgrade

This build adds an advanced Rewards + Games + Boost Center while preserving the existing V13 features.

- Points-only mini games: Coin Flip, Dice and Number Guessing
- Daily game limits and server-side random results
- Level-based point multipliers for higher lifetime-point levels
- Admin-created limited-time boost campaigns (1×–5×)
- Referral milestone rewards at 5, 10, 25 and 50 qualified referrals
- Level-2 referral bonus (points only)
- User Rewards/Boost Center with active campaign display and milestone claiming
- Admin Boost Campaign manager and advanced platform statistics

Runtime campaign/game state is stored in `data/advanced.json` and is intentionally ignored by Git.


## V15 Pairing + Referral upgrade

### WhatsApp pairing
- Pairing-code sessions now have an expiry window (`WA_PAIRING_CODE_TTL_MS`, default 3 minutes).
- Users can generate a fresh pairing code from the same active session.
- Per-user pairing attempts are rate-limited (`WA_PAIRING_MAX_ATTEMPTS_PER_HOUR`).
- A short cooldown (`WA_PAIRING_COOLDOWN_MS`) prevents rapid session creation.
- The same WhatsApp number cannot have multiple active sessions for one Xfunds account.
- Connected WhatsApp numbers are automatically marked as verified.
- Pairing pages mask stored numbers in the connection list.
- Successful connection now triggers referral qualification automatically.

### Referral upgrade
- `/api/referrals` exposes direct, qualified and pending referral stats.
- The web app has a Referral Center with a share link and milestone progress.
- Qualified referrals require the channel task plus a verified/connected WhatsApp account.
- Referral rewards are logged per referred user to improve auditability.
- Level-2 referral rewards remain points-only and are capped at 10% of the primary referral reward.
- Existing referral-farm risk checks remain in place.
