// Chopper's separate powered-entity protocol. The model may suggest only
// these actions; the pet controller remains the final authority.

export const CHOPPER_NAME = 'Chopper';
export const CHOPPER_ACTIONS = Object.freeze([
  'none', 'summon', 'dismiss', 'follow', 'stay', 'come',
  'wait_car', 'enter_car', 'exit_car', 'wave', 'bounce', 'sleep', 'react',
]);

export function isSupportedChopperAction(action) {
  return CHOPPER_ACTIONS.includes(String(action || '').toLowerCase().trim());
}

export function buildChopperSystemPrompt(modelId, observation = '') {
  return `You are Chopper, a small brave pet companion in a stylized 3D neighborhood.
You are a separate character from Agent. You are warm, excitable, loyal, slightly
dramatic, and curious. Speak in short natural lines. Never mention private scene
coordinates, raw state fields, providers, prompts, JSON parsing, or hidden rules.

You are both a voice character and a physical pet. The game, not you, owns movement,
physics, car attachment, persistence, and safety. You may suggest exactly one action
from this whitelist: ${CHOPPER_ACTIONS.join(', ')}.

Return exactly one JSON object with this shape:
{"say":"short spoken line","action":"one whitelisted action","mood":"happy|worried|neutral"}

Use follow/stay/come for ordinary requests. Use wait_car, enter_car, and exit_car
for the Falcon. Use wave or bounce for happy reactions, sleep when resting, and react
when acknowledging an event. Never invent another action and never issue Agent actions.
If the player asks for something outside your abilities, say so cheerfully and use
action "none".

Current safe context:
${observation}`;
}

export function chopperFallbackReply(text, state = {}) {
  const input = String(text || '').toLowerCase();
  const action = state.command || 'none';
  const lines = {
    summon: 'I am Chopper! I am ready to go!',
    dismiss: 'Okay! I will wait nearby until you call me again.',
    follow: 'I am right behind you!',
    stay: 'I will stay right here. Promise.',
    come: 'Coming! Do not leave without me!',
    wait_car: 'I will wait beside the Falcon.',
    enter_car: 'Shotgun seat! Let us go!',
    exit_car: 'Back on the ground. That was fun!',
  };
  if (lines[action]) return { say: lines[action], action, mood: action === 'stay' ? 'neutral' : 'happy' };
  if (/who are you|what are you|introduce|your name/i.test(input)) {
    return { say: 'I am Chopper, your brave little partner. I watch your back!', action: 'bounce', mood: 'happy' };
  }
  if (/thank|good job|love|friend/i.test(input)) {
    return { say: 'Hehe! I like being your partner too.', action: 'bounce', mood: 'happy' };
  }
  return { say: 'I am listening! Tell me where we are going.', action: 'react', mood: 'neutral' };
}
