export function pickPreferredVoice(voices, options = {}) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  const preferLocal = options.preferLocal !== false;
  const pool = preferLocal ? list.filter((v) => v.localService) : list;
  const activePool = pool.length ? pool : list;
  const norm = (value = '') => String(value).toLowerCase();
  const nameMatches = (voice, names) => names.some((name) => norm(voice?.name).includes(norm(name)));
  const langMatches = (voice, patterns) => patterns.some((pattern) => norm(voice?.lang).includes(norm(pattern)));

  const findVoice = (namePatterns = [], langPatterns = []) => {
    const byNameAndLang = activePool.find((voice) => nameMatches(voice, namePatterns) && langMatches(voice, langPatterns));
    if (byNameAndLang) return byNameAndLang;
    const byName = activePool.find((voice) => nameMatches(voice, namePatterns));
    if (byName) return byName;
    return activePool.find((voice) => langMatches(voice, langPatterns)) || null;
  };

  const indian = findVoice(['rishi'], ['en-in']) || activePool.find((voice) => /en[-_]?in/i.test(norm(voice?.lang))) || null;
  const english = findVoice(['alex', 'daniel', 'aaron', 'arthur', 'evan', 'nathan', 'tom', 'oliver', 'fred'], ['en'])
    || activePool.find((voice) => /^(en|en[-_][a-z]{2})/i.test(norm(voice?.lang)))
    || activePool[0] || null;
  const hindi = findVoice(['lekha', 'hindi'], ['hi'])
    || activePool.find((voice) => /^(hi|hi[-_][a-z]{2})/i.test(norm(voice?.lang)))
    || english;

  return {
    voice: indian || english,
    hindiVoice: hindi,
    indianVoiceFound: Boolean(indian),
  };
}
