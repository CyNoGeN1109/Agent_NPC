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
vercel env add SARVAM_API_KEY production        # paste the key at the prompt
vercel env add SARVAM_MODEL production          # optional: sarvam-105b-conversations
vercel --prod                # live!
```

Or without a terminal: vercel.com → New Project → import the folder/repo →
Settings → Environment Variables → add `SARVAM_API_KEY` → Deploy.

Sarvam is selected automatically when `SARVAM_API_KEY` is present. To force a
specific backend when multiple provider keys exist, add `NPC_BACKEND=sarvam`
or `NPC_BACKEND=openrouter`.

**Do NOT set `ELEVENLABS_API_KEY` in prod** unless you want to pay for cloud
TTS — visitors get the browser voice by default (which is how the game ships).

## What's already handled

- **Secrets**: `.env` is in `.vercelignore` — never uploaded. The key lives
  only in Vercel env vars, server-side.
- **Rate limiting**: per-IP 8 chat/min + a global-per-instance 40/min shield for the
  configured cloud key, plus an 80 provider-attempt/minute shield to bound
  JSON-format and fallback retries. Friendly 429 messages surface in-game.
- **Same-origin gate**: other sites can't embed your endpoint and farm the key.
- **Input caps**: message count/length capped server-side, malformed history
  rejected — a modified client can't inflate token spend.
- **Model fallback chain**: Sarvam uses its configured model; OpenRouter keeps
  its existing free-model fallback chain.
- **Per-user sessions**: his memory/relationship live in each visitor's
  localStorage — every player gets their own him, no backend state.
- **83MB character.fbx excluded** (bandwidth). The game auto-falls back to the
  built-in Xbot player. Compress it to a GLB (<10MB) later and remove the
  `.vercelignore` line to ship it.

## The real limit to know about

These shields are intentionally in-memory because this project has no shared
quota store. They reset on cold starts and are separate per Vercel function
instance, so they are burst protection, not a globally enforceable billing
quota. Before sharing a public deployment, configure the provider's own usage
limit/budget controls in the Sarvam or OpenRouter dashboard. A truly global
application quota would require adding shared infrastructure such as a hosted
Redis/KV store.

## Alternative

Cloudflare Pages + Functions — better free bandwidth (unlimited static) if the
FBX must ship. Same shape: static `web/` + two functions. Vercel is the faster
path today.
