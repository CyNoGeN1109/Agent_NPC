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
