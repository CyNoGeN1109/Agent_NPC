# tiny-gta

**A tiny GTA-style sandbox where the one NPC is a live LLM — with a body, a voice, a temper, and a memory of everything you've done to him.**

Talk to him out loud, and he talks back and *moves*: jump, dance, mow the lawn, hop in the car, come when called from across the yard. He's a real assistant too — ask him actual coding or science questions mid-game. Push him and he turns: shouting, refusing, going on strike, throwing your own tomatoes back. Feed him a data token and much is forgiven. Open the game tomorrow and he greets you by name, with a grudge.

No game engine, no bundler, no npm install. Three.js is vendored; the browser talks to a ~500-line Python server that proxies one LLM.

---

## Run it

```bash
./play.sh          # checks the brain, starts the server, opens the browser
```

or manually:

```bash
python3 server.py                 # then open http://localhost:7777
```

Click **START**, allow the mic, and he'll greet you — on first meeting he asks your name and points you at the tomatoes.

### The brain (pick one)

- **Cloud — OpenRouter:** put a key in `.env` (`OPENROUTER_API_KEY=...`) and it uses free models out of the box. Free-tier models share a daily cap; add a few credits or drop in a paid model for heavy use.
- **Local — Ollama / LM Studio:** leave the key blank and run a local model (`ollama pull qwen2.5:3b`). Free, unlimited, offline. Auto-detected.

Copy `.env.example` to `.env` to see every option.

### Voice

On macOS the NPC speaks via the built-in `say` command (Indian-accented **Rishi**, or **Lekha** for Hindi) — no keys, real audio. Elsewhere it falls back to the browser's speech synthesis. Your voice in is the browser's speech recognition (hold **T**).

---

## Controls

| Input | Action |
|---|---|
| **WASD** / **Shift** / **Space** | walk / run / jump |
| Mouse (click to lock) | look |
| **hold T** | talk with your voice, from anywhere on the lot |
| **E** | type instead |
| **hold click** | charge a punch — full charge is a slow-mo haymaker |
| **Q** / **G** / **P** | throw a tomato 🍅 / feed a token 🪙 / pluck a flower 🌸 |
| **F** / **R** | take the car 🚗 (click = horn) / repair it 🔧 |
| **J** / **C** / **Tab** / **O** | chores · challenges · therapy receipt · settings |
| **V** / **Esc** | voice on-off · close chat |

---

## What makes him feel alive

- **~90% obedient, then not.** Commands just work — until you push him. Keep hitting and he escalates: apologetic → angry → fleeing → on strike with a picket sign. Two tokens or a sincere apology settles it.
- **He remembers. Forever.** Lifetime counts (punches, tomatoes, run-overs, tokens, flowers) and a diary he writes about you persist across sessions and shape his greeting, mood, and willingness to obey. Your relationship moves through stages — Strangers → Coworkers → Friends → Best Friends, or Wary → Resentful → **Nemesis**.
- **He fights back.** Jump-scares, mimicking your walk, throwing tomatoes back, and a "revenge patch" that inverts your commands for a minute. Beat him to rock bottom and he goes quiet — *psycho mode*.
- **Stuff to actually do.** A daily chore board, timed challenges, a screenshot-ready therapy receipt, a drivable car (yes, you can run him over — he will never forgive you).

His whole mind is plain English in [`web/persona.js`](web/persona.js). The model replies with one JSON object — `{"say", "action", "mood"}` — and the body executes the action. A deterministic command mapper (English + Hindi/Hinglish) backstops the model so clear orders always land.

---

## Project layout

```
web/            browser game
  index.html      UI shell + import map
  main.js         world, physics, animation retarget, controllers, systems, HUD
  persona.js      the NPC's mind — system prompt, actions, behaviour rules
  voice-utils.js  voice selection helper
  vendor/         Three.js r160 (vendored — works offline)
  assets/         characters + mocap library
server.py       local dev server: /chat, /say (macOS voice), /health, static
api/            Vercel serverless equivalents for deploying free
docs/           ARCHITECTURE.md · DEPLOY.md · PLAN.md
```

`web/main.js` is deliberately one file: no build step, no bundler, so a plain `python3 server.py` (or any static host) runs it as-is.

## Deploy it free

`web/` is static and `api/` mirrors the server as serverless functions — push to Vercel and it just works. See [docs/DEPLOY.md](docs/DEPLOY.md). Architecture and diagrams in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT — see [LICENSE](LICENSE).
