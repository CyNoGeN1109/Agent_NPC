# Deploying tiny-gta free on Vercel

The repo is deploy-ready: `web/` is served static, `api/` are serverless
functions replacing `server.py` (same endpoints: `/chat`, `/tts`, `/health`).
`server.py` remains the local dev server — nothing changes for local play.

## One-time (about 5 minutes)

```bash
npm i -g vercel
cd tiny-gta
vercel login
vercel                       # first deploy (accept defaults, no build step)
vercel env add OPENROUTER_API_KEY production   # paste the key at the prompt
vercel --prod                # live!
```

Or without a terminal: vercel.com → New Project → import the folder/repo →
Settings → Environment Variables → add `OPENROUTER_API_KEY` → Deploy.

**Do NOT set `ELEVENLABS_API_KEY` in prod** unless you want to pay for cloud
TTS — visitors get the browser voice by default (which is how the game ships).

## What's already handled

- **Secrets**: `.env` is in `.vercelignore` — never uploaded. The key lives
  only in Vercel env vars, server-side.
- **Rate limiting**: per-IP 8 chat/min + a global 40/min shield for the
  OpenRouter key. Friendly 429 messages surface in-game.
- **Same-origin gate**: other sites can't embed your endpoint and farm the key.
- **Input caps**: message count/length capped server-side, malformed history
  rejected — a modified client can't inflate token spend.
- **Model fallback chain**: same as local (hy3 → nemotron → laguna → gpt-oss).
- **Per-user sessions**: his memory/relationship live in each visitor's
  localStorage — every player gets their own him, no backend state.
- **83MB character.fbx excluded** (bandwidth). The game auto-falls back to the
  built-in Xbot player. Compress it to a GLB (<10MB) later and remove the
  `.vercelignore` line to ship it.

## The real limit to know about

OpenRouter **free models**: ~20 req/min, and **50 requests/day total** if your
account has never held credits — **1000/day if you've bought $10 of credits
once**. For anything public, buy the $10 once; otherwise the whole game world
goes mute at 50 messages/day across ALL players.

## Alternative

Cloudflare Pages + Functions — better free bandwidth (unlimited static) if the
FBX must ship. Same shape: static `web/` + two functions. Vercel is the faster
path today.
