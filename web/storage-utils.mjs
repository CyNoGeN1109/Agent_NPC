// Small defensive boundary for browser storage. Keeping this separate makes
// the failure behavior easy to exercise without booting the 3D scene.
export function storageGet(storage, key, fallback = null) {
  try {
    const value = storage?.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function storageSet(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageJson(storage, key, fallback) {
  const raw = storageGet(storage, key, null);
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function finiteStoredNumber(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function sanitizeStoredName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{M}\s'-]/gu, '').trim().slice(0, 24);
}

export function normalizeMemory(raw, fallbackFirstSeen = new Date().toISOString().slice(0, 10)) {
  const base = {
    sessions: 0, punches: 0, heavyPunches: 0, tomatoHits: 0, runOvers: 0,
    kos: 0, tokens: 0, obeyed: 0, insults: 0, flowers: 0,
    playerName: '', firstSeen: fallbackFirstSeen, diary: [],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const counts = Object.fromEntries(Object.keys(base)
    .filter((key) => !['playerName', 'firstSeen', 'diary'].includes(key))
    .map((key) => [key, finiteStoredNumber(raw[key], base[key])]));
  const diary = Array.isArray(raw.diary)
    ? raw.diary.filter((entry) => entry && typeof entry === 'object').map((entry) => ({
      session: finiteStoredNumber(entry.session),
      text: String(entry.text ?? '').slice(0, 240),
      fromModel: entry.fromModel === true,
    })).slice(-50)
    : [];
  return {
    ...base,
    ...counts,
    playerName: sanitizeStoredName(raw.playerName),
    firstSeen: String(raw.firstSeen ?? base.firstSeen).slice(0, 32),
    diary,
  };
}
