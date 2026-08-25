export function modalShortcut(modal, code, repeat = false) {
  if (repeat) return null;
  if (modal === 'stats' && code === 'Tab') return 'close-stats';
  if (modal === 'board' && code === 'KeyJ') return 'close-board';
  if (modal === 'challenges' && code === 'KeyC') return 'close-challenges';
  if (modal === 'settings' && code === 'KeyO') return 'close-settings';
  if (modal === 'challenges' && /^Digit[123]$/.test(code)) {
    return `challenge:${+code.slice(-1)}`;
  }
  return null;
}
