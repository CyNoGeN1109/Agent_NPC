export function isSupportedAction(action, actions) {
  const normalized = String(action || '').toLowerCase().trim();
  if (actions.includes(normalized)) return true;
  return /^jump:[1-8]$/.test(normalized);
}

export function restoreHistory(history, snapshot) {
  history.splice(0, history.length, ...snapshot);
}

export function enqueueBounded(queue, text, max = 8) {
  if (queue.length >= max) return false;
  queue.push(text);
  return true;
}

export function coalesceOverflow(queue, index, count, text) {
  const prefix = '[event] Additional background events were coalesced while you were thinking.';
  const latest = String(text).slice(0, 600);
  const marker = `${prefix} (${count} total). Latest dropped event: ${latest}`;
  const current = queue[index] || '';
  const markerIndex = current.indexOf(`\n${prefix}`);
  queue[index] = markerIndex === -1
    ? `${current}\n${marker}`
    : `${current.slice(0, markerIndex)}\n${marker}`;
}
