#!/usr/bin/env python3
"""tiny-gta local server.

Serves the game (./web) and proxies /chat to an LLM:
  - OpenRouter    (cloud, preferred in auto mode when OPENROUTER_API_KEY is set)
  - Ollama        (local, http://localhost:11434)
  - LM Studio     (local, OpenAI-compatible, http://localhost:1234/v1)

Zero dependencies — Python stdlib only. Reads ./.env (KEY=VALUE per line) at
startup — never commit that file (see .gitignore); an already-set shell env
var always wins over the file.

Env vars:
  NPC_MODEL          model name (Ollama; default: largest model found)
  NPC_BACKEND        "ollama" | "openai" | "openrouter" | "auto" (default: auto)
  OLLAMA_URL         default http://localhost:11434
  OPENAI_URL         default http://localhost:1234/v1
  OPENROUTER_API_KEY OpenRouter API key (enables the openrouter backend)
  OPENROUTER_MODEL   default tencent/hy3:free
  OPENROUTER_URL     default https://openrouter.ai/api/v1
  ELEVENLABS_API_KEY optional — NPC speaks with an ElevenLabs voice when set
  NPC_VOICE_ID       ElevenLabs voice id (default N2lVS1w4EtoT3dr4eOWO — Callum,
                     a premade voice that works on the free tier via API)
  PORT               default 7777
"""

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def load_dotenv(path):
    """Minimal stdlib .env loader — KEY=VALUE per line, '#' comments, no
    dependency on python-dotenv. Never overrides an already-set env var, so
    `FOO=x python3 server.py` still wins over the file."""
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key, val = key.strip(), val.strip().strip('"').strip("'")
                os.environ.setdefault(key, val)
    except FileNotFoundError:
        pass


load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

PORT = int(os.environ.get("PORT", "7777"))
WEB_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OPENAI_URL = os.environ.get("OPENAI_URL", "http://localhost:1234/v1")

# --- OpenRouter (optional cloud backend; takes priority over Ollama in auto
# mode when a key is present — see detect_backend()) ---
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = os.environ.get("OPENROUTER_URL", "https://openrouter.ai/api/v1")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "tencent/hy3:free")
# Free-tier models rate-limit unpredictably, so ROTATE through several small/fast
# ones — when the primary 429s, the next answers immediately. NOTE: all :free
# models share ONE free-tier daily cap; when that's exhausted the whole chain
# 429s and only credits/local-Ollama/a-paid-model help. All IDs verified present
# in OpenRouter's live free list. No giant models here (the 550B took ~60s).
OPENROUTER_FALLBACKS = [m.strip() for m in os.environ.get(
    "OPENROUTER_FALLBACKS",
    "nvidia/nemotron-nano-9b-v2:free,"
    "openai/gpt-oss-20b:free,"
    "poolside/laguna-xs-2.1:free").split(",") if m.strip()]

# --- ElevenLabs voice (optional): if ELEVENLABS_API_KEY is set, the NPC speaks
# with this voice; otherwise the client falls back to the built-in macOS voice.
ELEVEN_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
# Callum "Husky Trickster" — a premade voice that works on the ElevenLabs FREE
# tier via API. (Professional/library voices like Manav/Abhay need a paid plan.)
ELEVEN_VOICE = os.environ.get("NPC_VOICE_ID", "N2lVS1w4EtoT3dr4eOWO")
ELEVEN_MODEL = os.environ.get("ELEVEN_MODEL", "eleven_turbo_v2_5")
TTS_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tts-cache")

# --- macOS `say` voice (local, free, no key). This is the RELIABLE voice path:
# browser speechSynthesis is silent on some machines, so the client asks the
# server to synthesize a WAV with macOS `say` and just plays the audio. Only
# available when running locally on a Mac (not on a cloud deploy).
SAY_AVAILABLE = platform.system() == "Darwin" and shutil.which("say") is not None
# "Rishi" is macOS's male en_IN voice with a strong, clear INDIAN ACCENT — the
# right feel for the Hinglish NPC (Aman/Siri sounds nearly American). Replies in
# romanized Hinglish read best on an en_IN English voice; a reply in actual
# Devanagari switches to "Lekha" (hi_IN) for authentic Hindi pronunciation.
# Override either via NPC_SAY_VOICE / NPC_SAY_VOICE_HI.
SAY_VOICE = os.environ.get("NPC_SAY_VOICE", "Rishi")
SAY_VOICE_HI = os.environ.get("NPC_SAY_VOICE_HI", "Lekha")
DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")


def say_tts(text):
    """macOS `say` → WAV bytes, cached on disk so repeat lines are instant.
    Picks a Hindi voice when the text is actually Devanagari, else the
    Indian-accented English voice."""
    voice = SAY_VOICE_HI if DEVANAGARI_RE.search(text) else SAY_VOICE
    key = hashlib.sha1(f"{voice}|{text}".encode()).hexdigest()
    os.makedirs(TTS_CACHE, exist_ok=True)
    cached = os.path.join(TTS_CACHE, f"say-{key}.wav")
    if os.path.exists(cached):
        with open(cached, "rb") as f:
            return f.read()
    base = ["say", "--file-format=WAVE", "--data-format=LEI16@22050", "-o", cached]
    try:
        subprocess.run(base + ["-v", voice, text], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        # a bad/absent voice name → retry once with the system default voice
        subprocess.run(base + [text], check=True, timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(cached, "rb") as f:
        return f.read()

THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)


def http_json(url, payload=None, timeout=180, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=req_headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def detect_backend():
    """Returns (backend, model) or (None, None)."""
    forced = os.environ.get("NPC_BACKEND", "auto")
    model = os.environ.get("NPC_MODEL", "")

    # OpenRouter needs no network probe (just an env var) and, per current
    # setup, is the preferred backend "for now" — checked first in auto mode.
    if forced in ("auto", "openrouter") and OPENROUTER_API_KEY:
        return "openrouter", model or OPENROUTER_MODEL

    if forced in ("auto", "ollama"):
        try:
            tags = http_json(f"{OLLAMA_URL}/api/tags", timeout=5)
            models = tags.get("models", [])
            if models:
                if not model:
                    names = [m["name"] for m in models]
                    # Real-time voice chat needs FAST replies. Reasoning models
                    # (deepseek-r1) deliberate for 10-50s per line, so prefer a
                    # non-reasoning model by default. Force any model with:
                    #   NPC_MODEL=deepseek-r1:8b python3 server.py
                    # gemma checked last: small gemma builds (e.g. gemma4:e2b, ~2B)
                    # are prone to repeating protocol keys ("say say say...")
                    # under strict JSON mode — qwen/llama have been reliable here.
                    for prefix in ("qwen2.5", "llama3", "qwen3", "qwen", "mistral", "gemma"):
                        hit = [n for n in names if n.startswith(prefix)]
                        if hit:
                            model = hit[0]
                            break
                    else:
                        model = max(models, key=lambda m: m.get("size", 0))["name"]
                return "ollama", model
        except Exception:
            if forced == "ollama":
                return None, None

    if forced in ("auto", "openai"):
        try:
            listing = http_json(f"{OPENAI_URL}/models", timeout=5)
            models = listing.get("data", [])
            if models:
                if not model:
                    model = models[0]["id"]
                return "openai", model
        except Exception:
            pass

    return None, None


def strip_think(text):
    return THINK_RE.sub("", text).strip()


PROTOCOL_KEYS = {"say", "reply", "text", "message", "action", "act", "mood"}
# Small models under decoding pressure sometimes loop a single token before
# breaking into real content ("say say say say Narendra Modi") — collapse any
# run of 3+ identical consecutive words down to nothing (it's never intended
# content; nobody says the same word four times in a row on purpose).
REPEAT_RUN_RE = re.compile(r"\b(\w+)(?:\s+\1\b){2,}\s*", re.IGNORECASE)


def _dequeue_key_echoes(text):
    """Strip a LEADING run of bare protocol-key tokens ("say action stay mood
    curious hi") that appears when a model abandons JSON entirely. Only
    strips from the front, so real sentences that merely contain the word
    "action" mid-thought are never touched."""
    words = text.split()
    i = 0
    while i < len(words) and words[i].strip(':",').lower() in PROTOCOL_KEYS:
        i += 1
    return " ".join(words[i:]) if i else text


# Narrow, high-precision: strips only the exact schema-echo fingerprint
# "action <word> mood <word>" at the very END of a string (what a model
# free-writes when it "closes out" the JSON fields as plain words). Anchored
# to both keywords + end-of-string so an organic sentence merely containing
# "action" or "mood" is never touched (verified: "you should take action on
# that bug" and "let's discuss mood boards, actionable stuff" both survive).
TRAIL_SCHEMA_RE = re.compile(r"\s+action\s+\S{1,24}\s+mood\s+\S{1,24}\s*$", re.IGNORECASE)


def normalize_reply(text):
    """Return one safe protocol object even when a local model ignores JSON mode."""
    clean = FENCE_RE.sub("", strip_think(text)).strip()
    start = clean.find("{")
    if start >= 0:
        try:
            obj, _ = json.JSONDecoder().raw_decode(clean[start:])
            if isinstance(obj, dict):
                say = obj.get("say", obj.get("reply", obj.get("text", obj.get("message", ""))))
                say = REPEAT_RUN_RE.sub("", str(say).strip()).strip()
                return json.dumps({
                    "say": say or "…",
                    "action": str(obj.get("action", obj.get("act", "none"))).lower().strip() or "none",
                    "mood": str(obj.get("mood", "")).strip(),
                })
        except (json.JSONDecodeError, TypeError, ValueError):
            pass
    # No parseable JSON at all — the model free-wrote something. Strip a
    # leading echo of the protocol keys, a trailing "action X mood Y" echo,
    # then any repeated-word loop, before treating the rest as a legitimate
    # plain-text answer.
    loose = _dequeue_key_echoes(clean)
    loose = TRAIL_SCHEMA_RE.sub("", loose)
    loose = REPEAT_RUN_RE.sub("", loose).strip()
    return json.dumps({"say": loose or clean or "…", "action": "none", "mood": ""})


NPC_REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "say": {"type": "string"},
        "action": {"type": "string"},
        "mood": {"type": "string"},
    },
    "required": ["say", "action", "mood"],
}


def chat_ollama(model, messages):
    # High num_predict is a CEILING, not a target — non-thinking models stop at
    # the closing brace. Reasoning models (deepseek-r1, qwen3) need the
    # headroom because their hidden thinking counts against the budget.
    base = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": 0.8,
            "num_predict": 3000,
            # Small models otherwise loop on a protocol key ("say say say…")
            # before producing real content — penalize repeats and cap how
            # far back the penalty looks so normal short replies aren't hurt.
            "repeat_penalty": 1.3,
            "repeat_last_n": 48,
        },
    }
    # Preference order: real JSON SCHEMA (constrains the exact shape, not just
    # "valid json" — this is what actually stops key-echo loops) -> loose
    # "json" string -> plain. Older Ollama versions may reject "think" or a
    # schema object for "format"; each fallback relaxes one constraint.
    attempts = [
        {**base, "think": False, "format": NPC_REPLY_SCHEMA},
        {**base, "format": NPC_REPLY_SCHEMA},
        {**base, "think": False, "format": "json"},
        {**base, "format": "json"},
        base,
    ]
    last_err = None
    for payload in attempts:
        try:
            resp = http_json(f"{OLLAMA_URL}/api/chat", payload)
            content = strip_think(resp["message"]["content"])
            if not content:
                # model spent the whole budget thinking — try the next shape
                last_err = "empty reply (model never finished thinking)"
                continue
            return content
        except urllib.error.HTTPError as e:
            last_err = f"ollama HTTP {e.code}: {e.read().decode()[:200]}"
        except Exception as e:  # connection errors, bad shape, etc.
            last_err = f"ollama error: {e}"
    raise RuntimeError(last_err)


def ollama_other_models(exclude):
    try:
        tags = http_json(f"{OLLAMA_URL}/api/tags", timeout=5)
        names = [m["name"] for m in tags.get("models", [])]
        return [n for n in names if n != exclude]
    except Exception:
        return []


def tts_eleven(text):
    """Text → MP3 bytes via ElevenLabs, with a local file cache so repeated
    lines (greeting, 'Ow!', common replies) cost zero quota after the first."""
    key = hashlib.sha1(f"{ELEVEN_VOICE}|{ELEVEN_MODEL}|{text}".encode()).hexdigest()
    os.makedirs(TTS_CACHE, exist_ok=True)
    cached = os.path.join(TTS_CACHE, f"{key}.mp3")
    if os.path.exists(cached):
        with open(cached, "rb") as f:
            return f.read()
    # a touch of expressiveness; retry bare if a model rejects the settings
    voice_settings = {"stability": 0.4, "similarity_boost": 0.8,
                      "style": 0.3, "use_speaker_boost": True}
    attempts = [
        (ELEVEN_MODEL, voice_settings),
        ("eleven_multilingual_v2", voice_settings),  # handles Hinglish well
        ("eleven_multilingual_v2", None),
    ]
    last_err = None
    for model, settings in attempts:
        try:
            payload = {"text": text, "model_id": model}
            if settings:
                payload["voice_settings"] = settings
            req = urllib.request.Request(
                f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVEN_VOICE}",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json", "xi-api-key": ELEVEN_KEY},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                audio = resp.read()
            with open(cached, "wb") as f:
                f.write(audio)
            return audio
        except urllib.error.HTTPError as e:
            last_err = f"elevenlabs HTTP {e.code}: {e.read().decode()[:200]}"
        except Exception as e:
            last_err = f"elevenlabs error: {e}"
    raise RuntimeError(last_err)


def chat_openai(model, messages):
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": 220,
    }
    resp = http_json(f"{OPENAI_URL}/chat/completions", payload)
    return strip_think(resp["choices"][0]["message"]["content"])


def chat_openrouter(model, messages):
    """Walks primary model + free-tier fallbacks; returns (content, model_used)."""
    if not OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "X-Title": "tiny-gta",
    }
    # primary first, then the free fallbacks (deduped, order preserved)
    chain = [model] + [m for m in OPENROUTER_FALLBACKS if m != model]
    last_err = None
    for i, m in enumerate(chain):
        base = {
            "model": m,
            "messages": messages,
            "temperature": 0.8,
            # 500 is plenty for a spoken line (or a short code answer) and caps
            # the worst case if a model rambles — 900 let replies run long/slow.
            "max_tokens": 500,
            # OpenAI-compatible equivalent of Ollama's repeat_penalty —
            # discourages the "say say say" key-echo loop on this backend too.
            "frequency_penalty": 0.5,
        }
        # A real schema beats loose "any valid json" at stopping key-echo
        # loops; not every provider supports it, so fall back per model.
        attempts = [
            {**base, "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "npc_reply", "strict": True, "schema": NPC_REPLY_SCHEMA},
            }},
            {**base, "response_format": {"type": "json_object"}},
        ]
        if i == len(chain) - 1:
            attempts.append(base)  # last resort: unconstrained
        for payload in attempts:
            try:
                # 18s ceiling: a real-time voice NPC can't hang for a minute on
                # one slow model — fail fast and try the next in the chain.
                resp = http_json(f"{OPENROUTER_URL}/chat/completions", payload,
                                 headers=headers, timeout=18)
                content = strip_think(resp["choices"][0]["message"]["content"])
                if content:
                    return content, m
                last_err = f"{m}: empty reply"
            except urllib.error.HTTPError as e:
                last_err = f"{m} HTTP {e.code}: {e.read().decode()[:160]}"
                if e.code in (401, 402):   # bad key / out of credits — no point retrying others
                    raise RuntimeError(last_err)
                break  # rate-limited/unsupported → next model, don't burn retries
            except Exception as e:
                last_err = f"{m} error: {e}"
                break
    raise RuntimeError(last_err)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def end_headers(self):
        # code stays fresh, but heavy assets (87MB FBX, GLBs, vendor libs)
        # are immutable-ish — let the browser cache them
        path = self.path.split("?")[0]
        if path.startswith("/assets/") or path.startswith("/vendor/"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # quiet static-file noise; keep chat logs. args[0] on an error path
        # (e.g. a 404) is an HTTPStatus enum, not a string — `in` on that
        # raises TypeError and kills the connection, so stringify first.
        first = str(args[0]) if args else ""
        if "/chat" in first:
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            backend, model = detect_backend()
            if backend:
                self.send_json({"ok": True, "backend": backend, "model": model,
                                "tts": bool(ELEVEN_KEY), "say": SAY_AVAILABLE})
            else:
                self.send_json(
                    {"ok": False, "error": "No local model server found. "
                     "Start Ollama (`ollama serve`) or LM Studio's server."},
                    code=503,
                )
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/say":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode() or "{}")
                text = (body.get("text") or "").strip()[:950]
                if not SAY_AVAILABLE:
                    self.send_json({"error": "macOS `say` not available here"}, code=503)
                    return
                if not text:
                    self.send_json({"error": "text required"}, code=400)
                    return
                audio = say_tts(text)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            except Exception as e:
                self.send_json({"error": str(e)}, code=500)
            return
        if self.path == "/tts":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode() or "{}")
                text = (body.get("text") or "").strip()[:950]
                if not ELEVEN_KEY:
                    self.send_json({"error": "no ELEVENLABS_API_KEY set"}, code=503)
                    return
                if not text:
                    self.send_json({"error": "text required"}, code=400)
                    return
                audio = tts_eleven(text)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
            except Exception as e:
                self.send_json({"error": str(e)}, code=500)
            return
        if self.path != "/chat":
            self.send_json({"error": "not found"}, code=404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length).decode() or "{}")
            messages = body.get("messages", [])
            if not messages:
                self.send_json({"error": "messages required"}, code=400)
                return

            # Server-side history cap (smaller prompt = faster replies; also
            # guards against runaway token growth if the client changes)
            if len(messages) > 20:
                messages = [messages[0]] + messages[-19:]

            backend, model = detect_backend()
            if not backend:
                self.send_json(
                    {"error": "No local model server reachable "
                     "(tried Ollama and LM Studio)."}, code=503)
                return

            if backend == "ollama":
                try:
                    reply = chat_ollama(model, messages)
                except RuntimeError:
                    # chosen model failed (e.g. endless thinking) — fall back
                    # to another local model so the NPC always answers
                    reply = None
                    for alt in ollama_other_models(model):
                        try:
                            reply = chat_ollama(alt, messages)
                            model = alt
                            break
                        except RuntimeError:
                            continue
                    if reply is None:
                        raise
            elif backend == "openrouter":
                try:
                    reply, model = chat_openrouter(model, messages)
                except RuntimeError:
                    # cloud backend down/rate-limited — fall back to a local
                    # Ollama model if one happens to be running, so the NPC
                    # doesn't go mute just because the free tier hiccuped
                    ollama_backend, ollama_model = None, None
                    try:
                        tags = http_json(f"{OLLAMA_URL}/api/tags", timeout=5)
                        if tags.get("models"):
                            ollama_backend, ollama_model = "ollama", tags["models"][0]["name"]
                    except Exception:
                        pass
                    if not ollama_model:
                        raise
                    reply = chat_ollama(ollama_model, messages)
                    backend, model = ollama_backend, ollama_model
            else:
                reply = chat_openai(model, messages)
            self.send_json({"reply": normalize_reply(reply), "model": model})
        except Exception as e:
            self.send_json({"error": str(e)}, code=500)


def main():
    backend, model = detect_backend()
    print(f"tiny-gta  →  http://localhost:{PORT}")
    if backend:
        print(f"NPC brain: {model}  (via {backend})")
    else:
        print("WARNING: no local model server found — the world will load, "
              "but the NPC can't talk until Ollama or LM Studio is running.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
