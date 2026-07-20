// Vercel serverless /tts — ElevenLabs proxy (only active if ELEVENLABS_API_KEY
// is set in the project env; the game defaults to the browser voice anyway).
// Same protections as /chat plus an opportunistic /tmp cache per warm instance.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VOICE = process.env.NPC_VOICE_ID || 'N2lVS1w4EtoT3dr4eOWO'; // Callum (free-tier premade)
const MODEL = process.env.ELEVEN_MODEL || 'eleven_turbo_v2_5';

const ipHits = new Map();
function limited(ip) {
  const now = Date.now();
  if (ipHits.size > 5000) ipHits.clear();
  const e = ipHits.get(ip);
  if (!e || now > e.reset) { ipHits.set(ip, { count: 1, reset: now + 60000 }); return false; }
  return ++e.count > 10;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const host = req.headers.host || '';
  const origin = req.headers.origin || req.headers.referer || '';
  if (!host || !origin.includes(host)) return res.status(403).json({ error: 'forbidden' });
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'no ELEVENLABS_API_KEY set' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'tts rate limit' });

  const text = String(req.body?.text || '').trim().slice(0, 950);
  if (!text) return res.status(400).json({ error: 'text required' });

  const cacheFile = path.join('/tmp',
    `tts-${crypto.createHash('sha1').update(`${VOICE}|${MODEL}|${text}`).digest('hex')}.mp3`);
  try {
    const cached = fs.readFileSync(cacheFile);
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(cached);
  } catch { /* not cached on this instance */ }

  const attempts = [
    [MODEL, { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }],
    ['eleven_multilingual_v2', null],
  ];
  let lastErr = 'no attempts';
  for (const [model, settings] of attempts) {
    try {
      const payload = { text, model_id: model };
      if (settings) payload.voice_settings = settings;
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) { lastErr = `elevenlabs HTTP ${r.status}`; continue; }
      const audio = Buffer.from(await r.arrayBuffer());
      try { fs.writeFileSync(cacheFile, audio); } catch { /* tmp full — fine */ }
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.status(200).send(audio);
    } catch (e) { lastErr = `elevenlabs: ${e.message}`; }
  }
  return res.status(500).json({ error: lastErr });
};
