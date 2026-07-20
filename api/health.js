// Vercel serverless /health — mirrors server.py's health shape.
module.exports = (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ ok: false, error: 'no OPENROUTER_API_KEY configured on the server' });
  }
  res.status(200).json({
    ok: true,
    backend: 'openrouter',
    model: process.env.OPENROUTER_MODEL || 'tencent/hy3:free',
    tts: !!process.env.ELEVENLABS_API_KEY,
  });
};
