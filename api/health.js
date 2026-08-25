// Vercel serverless /health — mirrors server.py's health shape.
module.exports = (req, res) => {
  const backend = process.env.NPC_BACKEND || (process.env.SARVAM_API_KEY ? 'sarvam' : 'openrouter');
  if (!['sarvam', 'openrouter'].includes(backend)) {
    return res.status(503).json({ ok: false, error: `unsupported Vercel backend: ${backend}` });
  }
  const hasKey = backend === 'sarvam'
    ? !!process.env.SARVAM_API_KEY
    : !!process.env.OPENROUTER_API_KEY;
  if (!hasKey) {
    return res.status(503).json({ ok: false, error: `no ${backend.toUpperCase()} API key configured on the server` });
  }
  res.status(200).json({
    ok: true,
    backend,
    model: backend === 'sarvam'
      ? (process.env.NPC_MODEL || process.env.SARVAM_MODEL || 'sarvam-105b-conversations')
      : (process.env.NPC_MODEL || process.env.OPENROUTER_MODEL || 'tencent/hy3:free'),
    tts: !!process.env.ELEVENLABS_API_KEY,
  });
};
