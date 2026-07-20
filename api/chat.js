// Vercel serverless /chat — OpenRouter proxy with the same fallback chain and
// reply sanitizer as server.py, so one client works locally AND deployed.
// Zero npm dependencies (Node 18+ built-in fetch).
//
// Abuse protection (this is a public, key-spending endpoint):
//   - same-origin gate: other websites can't farm your OpenRouter key
//   - per-IP rate limit: 8 req/min (in-memory; resets on cold start — fine,
//     it's burst protection, not billing)
//   - global per-instance limit: 40 req/min protects the free-tier key
//   - strict input caps: message count, per-message and total length

const MODEL = process.env.OPENROUTER_MODEL || 'tencent/hy3:free';
// rotate small/fast free models so a 429 on one falls straight through to the
// next. (All :free models share one daily cap; when it's exhausted the whole
// chain 429s — only credits/paid/local-Ollama help then.) No giants.
const FALLBACKS = (process.env.OPENROUTER_FALLBACKS ||
  'nvidia/nemotron-nano-9b-v2:free,openai/gpt-oss-20b:free,poolside/laguna-xs-2.1:free')
  .split(',').map((s) => s.trim()).filter(Boolean);

const SCHEMA = {
  type: 'object',
  properties: { say: { type: 'string' }, action: { type: 'string' }, mood: { type: 'string' } },
  required: ['say', 'action', 'mood'],
};

const THINK_RE = /<think>[\s\S]*?<\/think>/gi;
const FENCE_RE = /^\s*```(?:json)?\s*|\s*```\s*$/gi;
const REPEAT_RUN_RE = /\b(\w+)(?:\s+\1\b){2,}\s*/gi;
const TRAIL_SCHEMA_RE = /\s+action\s+\S{1,24}\s+mood\s+\S{1,24}\s*$/i;
const KEYS = new Set(['say', 'reply', 'text', 'message', 'action', 'act', 'mood']);

function normalize(raw) {
  const clean = String(raw || '').replace(THINK_RE, '').replace(FENCE_RE, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(clean.slice(start, end + 1));
      if (obj && typeof obj === 'object') {
        const say = String(obj.say ?? obj.reply ?? obj.text ?? obj.message ?? '')
          .replace(REPEAT_RUN_RE, '').trim();
        return JSON.stringify({
          say: say || '…',
          action: String(obj.action ?? obj.act ?? 'none').toLowerCase().trim() || 'none',
          mood: String(obj.mood ?? '').trim(),
        });
      }
    } catch { /* fall through to loose text */ }
  }
  const words = clean.split(/\s+/);
  let i = 0;
  while (i < words.length && KEYS.has(words[i].replace(/[:",]/g, '').toLowerCase())) i++;
  const loose = words.slice(i).join(' ').replace(TRAIL_SCHEMA_RE, '').replace(REPEAT_RUN_RE, '').trim();
  return JSON.stringify({ say: loose || clean || '…', action: 'none', mood: '' });
}

const ipHits = new Map();   // ip -> {count, reset}
let globalHits = { count: 0, reset: 0 };
function limited(ip) {
  const now = Date.now();
  if (now > globalHits.reset) globalHits = { count: 0, reset: now + 60000 };
  if (++globalHits.count > 40) return 'busy — too many players right now, try again in a minute';
  if (ipHits.size > 5000) ipHits.clear();
  const e = ipHits.get(ip);
  if (!e || now > e.reset) { ipHits.set(ip, { count: 1, reset: now + 60000 }); return null; }
  if (++e.count > 8) return 'slow down — she needs a breather (rate limit, ~1 min)';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const host = req.headers.host || '';
  const origin = req.headers.origin || req.headers.referer || '';
  if (!host || !origin.includes(host)) return res.status(403).json({ error: 'forbidden' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const limitMsg = limited(ip);
  if (limitMsg) return res.status(429).json({ error: limitMsg });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(503).json({ error: 'no OPENROUTER_API_KEY configured' });

  let messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  if (messages.length > 20) messages = [messages[0], ...messages.slice(-19)];
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role)) {
      return res.status(400).json({ error: 'bad message shape' });
    }
    m.content = m.content.slice(0, 9000);
    total += m.content.length;
  }
  if (total > 60000) return res.status(413).json({ error: 'history too large' });
  messages = messages.map((m) => ({ role: m.role, content: m.content })); // strip extras

  const chain = [MODEL, ...FALLBACKS.filter((m) => m !== MODEL)];
  let lastErr = 'no models tried';
  for (let ci = 0; ci < chain.length; ci++) {
    const m = chain[ci];
    const base = { model: m, messages, temperature: 0.8, max_tokens: 500, frequency_penalty: 0.5 };
    const attempts = [
      { ...base, response_format: { type: 'json_schema', json_schema: { name: 'npc_reply', strict: true, schema: SCHEMA } } },
      { ...base, response_format: { type: 'json_object' } },
    ];
    if (ci === chain.length - 1) attempts.push(base); // last resort: unconstrained
    for (const payload of attempts) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'tiny-gta' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(18000),
        });
        if (!r.ok) {
          lastErr = `${m} HTTP ${r.status}`;
          if (r.status === 401 || r.status === 402) return res.status(502).json({ error: lastErr });
          break; // rate-limited/unsupported → next model
        }
        const data = await r.json();
        const content = String(data.choices?.[0]?.message?.content || '').replace(THINK_RE, '').trim();
        if (content) return res.status(200).json({ reply: normalize(content), model: m });
        lastErr = `${m}: empty reply`;
      } catch (e) {
        lastErr = `${m}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`;
        break;
      }
    }
  }
  return res.status(502).json({ error: lastErr });
};
