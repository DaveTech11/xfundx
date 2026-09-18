# What changed in this build

## 1. Fixed "go to the bot" / website not usable
The root cause: anyone visiting the plain website (not through the Telegram
Mini App) got an anonymous, made-up account ID. Telegram can never confirm
a made-up ID actually joined your required channels, so channel tasks,
referral qualification, and **withdrawals** silently failed forever for
every website-only visitor — no matter what they did.

Fix: added a real **"Link Telegram" button** (Telegram Login Widget) that
appears on the homepage for website visitors. It lets them prove they own
a real Telegram account right on the site, no bot required. Once linked,
channel-membership checks work correctly for them.

**You must do one manual step for this to work when deployed:**
Message **@BotFather** on Telegram → `/setdomain` → select your bot →
enter your deployed site's domain (e.g. `https://your-app.onrender.com`).
Telegram Login Widgets only work on a domain registered this way.

Also fixed: the "Request VIP access" flow used to tell *every* user to
"DM the owner with your Telegram ID" — including website visitors who
don't have a linked Telegram account and therefore no real ID to give.
It now only shows that instruction to users who actually have one.

## 2. Video Center: Prev/Next
Videos used to show as a grid of every video at once. Now it shows one
video at a time with **← Prev** / **Next →** buttons and a "Video X of N"
counter. Starting a video's watch-timer and switching to another video
with Prev/Next doesn't lose progress — it keeps counting in the background
and picks up where you left off when you come back to it.

## 3. Pure black & white glass theme
`index.html`, `videos.html`, and `whatsapp.html` were re-themed: the teal
and green accent colors are gone, replaced with a true black background
and white/gray glass panels. Status text (pending/error) is now
distinguished by weight/style instead of color, to keep it readable
without reintroducing color.

(`admin.html` — the internal admin dashboard — was left as-is; it's not
part of the public-facing site.)

## Still needed from you before things work live
These aren't code bugs — they're deployment configuration only you can
supply:

- **BOT_TOKEN, BOT_USERNAME, ADMIN_ID(S)** — from @BotFather. Without a
  real `BOT_TOKEN`, the Mini App, the new Telegram Login Widget, and all
  admin notifications silently do nothing.
- **Register your domain** with `@BotFather` → `/setdomain` (see above) —
  required for the new "Link Telegram" button to work.
- **WEB_SESSION_SECRET** — set this to a long random string in production
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
  Without it, every website visitor's session resets on every server
  restart/redeploy, so they'd have to re-link Telegram and lose progress
  each time you redeploy.
- **REQUIRED_CHANNEL_1..5** — only fill in channels that really exist and
  where your bot is an admin. A placeholder/non-existent channel blocks
  verification for *everyone*, Telegram and web alike.
- **SMTP_HOST/USER/PASS** (email OTP) and **TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM**
  (SMS OTP) — email/phone verification codes will never send without
  real credentials here. If you don't have these yet, set
  `EMAIL_VERIFICATION_REQUIRED=false` and `PHONE_VERIFICATION_REQUIRED=false`
  so withdrawal isn't blocked on a step that can't complete.
- **Hosting**: the WhatsApp pairing feature (Baileys) needs a host that
  keeps one long-running Node process with persistent disk (Railway,
  Render, a VPS). It will not work on serverless/edge hosting (e.g.
  Vercel functions), since the WhatsApp socket connection and session
  files can't survive between requests there.
