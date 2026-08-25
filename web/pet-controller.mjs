// Pure pet state and safety boundary. Rendering, navigation, and the existing
// NPC/player/car controllers stay in main.js; this module owns only pet rules.

export const PET_COMMANDS = Object.freeze([
  'summon', 'dismiss', 'follow', 'stay', 'come', 'wait_car', 'enter_car', 'exit_car',
]);
export const PET_STATES = Object.freeze(['idle', 'follow', 'stay', 'car', 'sleepy']);
export const PET_MOODS = Object.freeze(['happy', 'worried', 'neutral']);
const DEFAULT_RELATIONSHIP = Object.freeze({
  commands: 0, following: 0, reactions: 0, rides: 0,
});

export function isSupportedPetCommand(command) {
  return PET_COMMANDS.includes(String(command || '').toLowerCase().trim());
}

export function normalizePetName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{M}\s'-]/gu, '').trim().slice(0, 24) || 'Chopper';
}

export function normalizePetState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const relationship = source.relationship && typeof source.relationship === 'object'
    ? source.relationship : {};
  const count = (value) => Number.isFinite(value) && value >= 0 ? Math.min(9999, Math.floor(value)) : 0;
  const mood = PET_MOODS.includes(source.mood) ? source.mood : 'neutral';
  return {
    // The pet is available by default; the flag remains persisted so a future
    // unlock gate can turn it off without changing the state shape.
    unlocked: source.unlocked !== false,
    name: normalizePetName(source.name),
    mood,
    relationship: {
      commands: count(relationship.commands),
      following: count(relationship.following),
      reactions: count(relationship.reactions),
      rides: count(relationship.rides),
    },
    // Runtime-only fields. serializePetState deliberately omits these.
    visible: source.visible === true,
    state: PET_STATES.includes(source.state) ? source.state : 'idle',
    goal: typeof source.goal === 'string' ? source.goal : '',
    inCar: source.inCar === true,
  };
}

export function serializePetState(state) {
  const safe = normalizePetState(state);
  return {
    unlocked: safe.unlocked,
    name: safe.name,
    relationship: { ...safe.relationship },
  };
}

export function setPetRuntimeState(rawState, state, goal = '') {
  const next = normalizePetState(rawState);
  next.state = PET_STATES.includes(state) ? state : 'idle';
  next.goal = typeof goal === 'string' ? goal.slice(0, 32) : '';
  next.visible = true;
  return next;
}

export function setPetMood(rawState, mood) {
  const next = normalizePetState(rawState);
  next.mood = PET_MOODS.includes(mood) ? mood : 'neutral';
  return next;
}

export function transitionPet(rawState, rawCommand) {
  const state = normalizePetState(rawState);
  const command = String(rawCommand || '').toLowerCase().trim();
  if (!isSupportedPetCommand(command)) {
    return { accepted: false, state, reason: 'unknown-pet-command' };
  }
  if (!state.unlocked && command !== 'summon') {
    return { accepted: false, state, reason: 'pet-locked' };
  }
  state.relationship.commands++;
  switch (command) {
    case 'summon':
      state.visible = true; state.inCar = false; state.state = 'follow'; state.goal = ''; state.mood = 'happy';
      break;
    case 'dismiss':
      state.visible = false; state.inCar = false; state.state = 'idle'; state.goal = '';
      break;
    case 'follow':
      state.visible = true; state.inCar = false; state.state = 'follow'; state.goal = ''; state.relationship.following++;
      break;
    case 'stay':
      state.visible = true; state.inCar = false; state.state = 'stay'; state.goal = '';
      break;
    case 'come':
      state.visible = true; state.inCar = false; state.state = 'follow'; state.goal = 'come';
      break;
    case 'wait_car':
      state.visible = true; state.inCar = false; state.state = 'stay'; state.goal = 'wait_car';
      break;
    case 'enter_car':
      state.visible = true; state.state = 'stay'; state.goal = 'enter_car';
      break;
    case 'exit_car':
      state.visible = true; state.inCar = false; state.state = 'stay'; state.goal = '';
      break;
    default:
      return { accepted: false, state, reason: 'unknown-pet-command' };
  }
  return { accepted: true, state, command };
}

export function petReaction(rawState, event, detail = '') {
  const state = normalizePetState(rawState);
  if (!state.visible || state.inCar) return { state, line: '' };
  state.relationship.reactions++;
  const key = String(event || '').toLowerCase();
  if (key === 'player_move') state.mood = 'happy';
  else if (key === 'npc_mood') state.mood = Number(detail) < 4 ? 'worried' : 'neutral';
  else if (key === 'tomato' || key === 'punch') state.mood = 'worried';
  else if (key === 'chat') state.mood = 'happy';
  const lines = {
    tomato: 'Chopper watches the tomato arc with wide eyes.',
    punch: 'Chopper takes one worried step back.',
    chat: 'Chopper tilts his hat, listening.',
  };
  return { state, line: lines[key] || '' };
}

export function petRecovery({ distance = 0, stuckSeconds = 0, state = 'follow', mode = state } = {}) {
  const currentState = state || mode;
  if (currentState === 'idle' || currentState === 'car') return 'none';
  if (stuckSeconds >= 0.9) return 'reroute';
  if (currentState === 'follow' && distance > 8) return 'come';
  return 'none';
}

export function petAssetFallback(result) {
  if (result && result.scene) return { fallback: false, reason: '' };
  const reason = String(result?.error?.message || result?.error || 'asset unavailable').slice(0, 160);
  return { fallback: true, reason };
}
