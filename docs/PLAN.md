# tiny-gta — Road to a Finished Game

Owner intent (Darsh, 2026-07-17): stop treating this as a tech demo. The goal is a
**proper finished game** — GTA-feel, strong hook, high polish — where a developer comes
to blow off steam at an agentic NPC: make her work, hit her, irritate her, bribe her,
and she *genuinely reacts, remembers, and retaliates*. The fun must survive past the
first 15 minutes and pull the player back tomorrow.

Current state: the sandbox core is DONE and good — voice push-to-talk, obedience +
deterministic mapper, happiness/punch/token economy, tomatoes, car run-over, KO,
achievements, expanded actions, ElevenLabs voice, chat history in localStorage.
What's missing is not features — it's **feel, memory, structure, and agency**.

Brain protocol is unchanged and sacred: browser → `POST /chat {messages}` → Ollama →
`{"say","action","mood"}`. Key files: `web/main.js`, `web/persona.js`, `server.py`.

---

## The hook, stated plainly

> "An AI employee who actually remembers what you did to her yesterday."

Everything below serves one of the four pillars:

1. **FEEL** — hitting/interacting must be physically satisfying (sound, impact, real humans).
2. **MEMORY** — nothing you do to her is ever forgotten. Tomorrow's session opens differently because of today.
3. **STRUCTURE** — things to *do*: her job list, challenges, a daily score. Sandbox alone dies in 15 min.
4. **AGENCY** — she's not a punching bag, she's an agent. She retaliates, pranks, strikes, negotiates.

---

## M1 — FEEL (do first; biggest minute-one impact)

### 1.1 Sound design (the single biggest missing juice)
Zero audio exists today outside TTS. Add via WebAudio (small mp3/ogg in `web/assets/sfx/`,
CC0 from freesound/kenney.nl):
- punch impact (2-3 variants, pitch-randomized), body-fall thud, tomato splat
- footsteps (grass/wood, both characters), jump/land
- car horn (exists as event — needs the actual honk), engine idle/rev for sit_in_car
- ambient bed: birds outside, room tone inside, crickets if night ever lands
- UI ticks: token feed *chomp*, achievement chime
Keep a tiny `sfx.js` helper: `play(name, {pitch, gain})`, pooled buffers.

### 1.2 Hit feel
- 60-90ms hit-stop (freeze both animations) on punch connect + 4-6px camera shake
- white damage flash on the NPC material for 80ms
- charged haymaker: bigger shake + slow-mo 0.3s (timeScale dip)

### 1.3 Real characters (owner action required — hand him this list)
Loader already tries `web/assets/npc.glb` / `player.glb` — code is ready, assets aren't.
Owner steps (~20 min): mixamo.com → pick a Vice City-looking pedestrian for the NPC +
any street character for the player → download clips: Idle, Walking, Running, Jump,
Sitting Idle, Stand Up, Falling Back Death, Getting Up, Waving, Punching, Hip Hop Dance,
Talking, Crawl → combine to one GLB each at mixamo2gltf.com → drop in `web/assets/`.
Agent then: verify scale ≈1.75m, `CFG.modelYaw`, delete procedural fallbacks that now
have real clips.

Acceptance: eyes-closed test — punching, walking, and feeding all *sound and feel*
different; a friend says "oh that's satisfying" unprompted.

## M2 — MEMORY (the retention hook)

### 2.1 Persistent NPC memory across sessions
- New `memory` object saved to localStorage (later: server-side JSON file so it survives
  browser clears): `{ totalHits, totalTokens, kos, tomatoes, runOvers, sessionsPlayed,
  playerName, lastSeen, notableEvents: [strings, cap 20], relationshipStage }`
- End of session (beforeunload + every 5 min): ask the model to write a 2-sentence diary
  entry ("what happened today, how I feel about the player") → store it.
- Boot greeting becomes memory-driven: first line references history —
  "Back again? My ribs still hurt from yesterday. 47 punches, I counted." This is the
  moment the player screenshots. Inject a `[memory]` block into the system prompt.

### 2.2 Relationship stages (long arc)
Derived from lifetime stats, shown as a title under the happiness meter:
Strangers → Coworkers → Friends → Best Friends | Wary → Resentful → Nemesis.
Stage changes announce themselves (achievement-style toast + a spoken line).
Persona gets stage-specific behavior notes (nemesis: opens hostile, demands tokens up
front; best friend: does chores unasked, defends you when you vent).

Acceptance: quit, reopen tomorrow → she references yesterday specifically and correctly.

## M3 — STRUCTURE (things to do)

### 3.1 Work mode — she's your intern
- A task board (small UI panel, key J): 5 daily chores auto-generated from existing
  actions (cut the grass, water plants, wash the Falcon*, tidy the table*, read a book).
  (*wash/tidy = new actions, trivial: goto + pose + emote.)
- You can order her through them, help, or torment her mid-task (she reacts: drops the
  task, complains, resumes). Completed board = daily bonus tokens + achievement.
- She works *autonomously* through the list if you tell her "get to work" — the fantasy
  of bossing an AI employee.

### 3.2 Challenge modes (key C, pick one)
Short scored runs, 60-120s, leaderboard-style local best:
- **Rage Quit** — make her quit/flee in under 60s (score: speed)
- **Model Citizen** — reach happiness 10 with zero tokens (only kindness/chores praise)
- **Marathon Boss** — full task board done in one game-day, any means (bribe/threat mix tracked)

### 3.3 Daily report card
On demand (or session end): a generated summary screen — hits, tokens, tasks done,
funniest quote of the session (she picks it), relationship delta. Shareable text.

Acceptance: a new player has an obvious "what do I do" answer at all times; average
session length doubles.

## M4 — AGENCY (she fights back)

This is what "agentic NPC" must mean. Escalating retaliation, gated by relationship
stage + happiness (all client-triggered so small models can't wimp out; persona
explains them in character):
- **pranks (mild):** hides in odd spots and jump-scares you; walks behind you mimicking
  your movements; steals a data token back from your count with a giggle
- **strike (organized):** plants a tiny picket sign, refuses ALL work, chants — ends via
  2 tokens or a sincere typed apology (she judges sincerity)
- **revenge (nemesis only):** throws the tomato BACK; honks the horn when you sit in the
  Falcon; the already-teased "revenge patch v2.0" — for one minute she inverts your
  commands ("jump" → she sits, cackling) until you feed her
- New actions needed: `hide`, `mimic`, `picket`, `throw_tomato_at_player`, `invert_mode`

Acceptance: playtester says "wait, did she just—?!" at least once per session.

## M5 — SHIP

- **Onboarding:** first 60s scripted beat — she greets, asks your name (stored in memory),
  dares you to make her do something, then *tells you where the tomatoes are*. Teaches
  T / click / G / E in-world, no tutorial screens.
- **Title screen** with her idling behind the menu, logo, model picker (list from
  /health), continue-shows-relationship-stage.
- **Settings panel:** volume sliders, voice on/off, sensitivity, model swap.
- **Packaging:** `./play.sh` one-command start (checks Ollama, pulls a default model if
  none, opens Chrome); then an itch.io page with a 60s trailer of the funniest moments.
- **Perf pass:** 60fps on the M3 with real characters; texture/shadow budget check.
- README rewrite to match reality (see "cut" below).

---

## Cut / parked (be honest in README)

- **Hindi voice I/O** — persona is now English-only by design; mapper keeps Hindi
  keywords as an easter egg. Un-park only if a Hindi-strong local model becomes the default.
- **whisper.cpp local STT** — park until after M5; Chrome recognizer is fine for the
  target user (a dev, online).
- **Second NPC / vision** — post-ship. Memory + retaliation deliver more hook per hour.

## Milestone order & effort guess

| # | Milestone | Effort | Why this order |
|---|---|---|---|
| 1 | M1 feel (sound+juice+characters) | 1-2 sessions | first-minute impression |
| 2 | M2 memory | 1 session | THE differentiator, cheap to build |
| 3 | M3 structure | 1-2 sessions | retention |
| 4 | M4 agency | 1-2 sessions | depth + virality moments |
| 5 | M5 ship | 1 session | package it |

## Definition of "finished"

- [ ] A dev friend plays 30+ min unprompted and comes back the next day
- [ ] She correctly references a specific thing you did in a previous session
- [ ] Every hit/feed/task has sound + visual feedback
- [ ] Characters look human, not robot placeholders
- [ ] She retaliates at least two different ways per session
- [ ] `./play.sh` → playing in under 30 seconds on a fresh clone (with Ollama installed)
- [ ] README, title screen, and gameplay all describe the same game
