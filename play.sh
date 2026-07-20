#!/bin/bash
# tiny-gta one-command launcher: checks Ollama, frees the port, starts the
# server, opens Chrome (best voice support). Fresh clone → playing in ~30s.
set -e
cd "$(dirname "$0")"

PORT="${PORT:-7777}"

# 1. Ollama up?
if ! curl -s --max-time 2 http://localhost:11434/api/tags > /dev/null; then
  echo "⚠️  Ollama isn't running."
  if command -v ollama > /dev/null; then
    echo "   starting it for you…"
    (ollama serve > /dev/null 2>&1 &)
    sleep 2
  else
    echo "   install it first:  brew install ollama   (or https://ollama.com)"
    echo "   the world will still load, but the NPC can't talk without a brain."
  fi
fi

# 2. Any model installed?
if command -v ollama > /dev/null; then
  if ! ollama list 2>/dev/null | tail -n +2 | grep -q .; then
    echo "📦 No local model found — pulling qwen2.5:7b (smart AND fast)…"
    ollama pull qwen2.5:7b
  fi
fi

# 3. Free the port if a stale server holds it
if command -v lsof >/dev/null 2>&1; then
  lsof -ti ":$PORT" | xargs kill 2>/dev/null || true
fi

# 4. Go
echo "🎮 tiny-gta → http://localhost:$PORT"
python3 server.py > /tmp/tiny-gta.log 2>&1 &
SERVER_PID=$!
for _ in 1 2 3 4 5; do
  if curl -s --max-time 1 "http://localhost:$PORT/health.js" > /dev/null 2>&1; then
    break
  fi
  sleep 1
done
if open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null; then :
else open "http://localhost:$PORT" 2>/dev/null || true; fi
trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait $SERVER_PID
