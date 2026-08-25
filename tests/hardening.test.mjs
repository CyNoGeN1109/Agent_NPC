import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { coalesceOverflow, enqueueBounded, isSupportedAction, restoreHistory } from '../web/brain-utils.mjs';
import { normalizeMemory, normalizeSettings, storageJson, storageSet } from '../web/storage-utils.mjs';
import { escapeHtml, renderLongReply } from '../web/text-render.mjs';
import { modalShortcut } from '../web/ui-guards.mjs';
import {
  CHOPPER_ACTIONS, buildChopperSystemPrompt, chopperFallbackReply,
  isSupportedChopperAction,
} from '../web/chopper-persona.mjs';
import {
  isSupportedPetCommand, normalizePetState, petAssetFallback, petReaction, petRecovery,
  serializePetState, transitionPet,
} from '../web/pet-controller.mjs';

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this._text = null;
    this.className = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  get textContent() {
    return this._text ?? this.children.map((child) => child.textContent).join('');
  }
}

const fakeDocument = {
  createElement: (tagName) => new FakeNode(tagName),
  createTextNode: (text) => new FakeNode('#text').withText(text),
};

FakeNode.prototype.withText = function withText(text) {
  this._text = String(text);
  return this;
};

function serialize(node) {
  if (node.tagName === '#text') return node._text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const attrs = node.className ? ` class="${node.className}"` : '';
  return `<${node.tagName}${attrs}>${node.children.map(serialize).join('')}</${node.tagName}>`;
}

function tags(node) {
  return [node.tagName, ...node.children.flatMap(tags)];
}

test('long model replies render HTML payloads as text and preserve code blocks', () => {
  const payload = '<img src=x onerror="window.__pwned=1">';
  const code = 'const safe = "<b>still text</b>";';
  const fence = '```';
  const reply = `${payload}\n\n${'ordinary words '.repeat(20)}\n${fence}js\n${code}\n${fence}`;
  const rendered = renderLongReply(reply, 'Agent', fakeDocument);

  assert.deepEqual(tags(rendered).filter((tag) => tag === 'img' || tag === 'script'), []);
  assert.equal(rendered.children.some((child) => child.tagName === 'pre'), true);
  const codeNode = rendered.children.find((child) => child.tagName === 'pre')?.children[0];
  assert.equal(codeNode.textContent.trim(), code);
  assert.match(serialize(rendered), /&lt;img src=x onerror=/);
});

test('persisted HTML payloads are escaped before insertion into trusted templates', () => {
  const payload = `\"><img src=x onerror=\"window.__pwned=1\">`;
  assert.equal(
    escapeHtml(payload),
    '&quot;&gt;&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;',
  );
});

test('memory normalization preserves the legacy diary upgrade flag', () => {
  const normalized = normalizeMemory({
    sessions: 4,
    playerName: 'A&B',
    diary: [{ session: 4, text: 'still remembered', fromModel: true }],
  }, '2026-08-25');

  assert.equal(normalized.playerName, 'AB');
  assert.deepEqual(normalized.diary[0], {
    session: 4,
    text: 'still remembered',
    fromModel: true,
  });
});

test('malformed and blocked storage values fall back without throwing', () => {
  const malformed = { getItem: () => '{not-json' };
  assert.deepEqual(storageJson(malformed, 'tiny-gta-ach', []), []);
  assert.equal(storageSet(null, 'tiny-gta-ach', '[]'), false);

  const blocked = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  assert.deepEqual(storageJson(blocked, 'tiny-gta-ach', []), []);
  assert.equal(storageSet(blocked, 'tiny-gta-ach', '[]'), false);
});

test('voice setting persists without mutating unrelated settings', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const key = 'tiny-gta-settings';
  const defaults = normalizeSettings(storageJson(storage, key, {}));
  assert.equal(defaults.voice, true);

  const saved = { ...defaults, volume: 0.35, sens: 1.4, fancy: true, voice: false };
  assert.equal(storageSet(storage, key, JSON.stringify(saved)), true);
  const reloadedOff = normalizeSettings(storageJson(storage, key, {}));
  assert.equal(reloadedOff.voice, false);
  assert.deepEqual(
    { volume: reloadedOff.volume, sens: reloadedOff.sens, fancy: reloadedOff.fancy },
    { volume: 0.35, sens: 1.4, fancy: true },
  );

  reloadedOff.voice = true;
  assert.equal(storageSet(storage, key, JSON.stringify(reloadedOff)), true);
  const reloadedOn = normalizeSettings(storageJson(storage, key, {}));
  assert.equal(reloadedOn.voice, true);
  assert.deepEqual(
    { volume: reloadedOn.volume, sens: reloadedOn.sens, fancy: reloadedOn.fancy },
    { volume: 0.35, sens: 1.4, fancy: true },
  );

  for (let i = 0; i < 3; i++) {
    assert.equal(storageSet(storage, key, JSON.stringify(reloadedOn)), true);
    assert.deepEqual(normalizeSettings(storageJson(storage, key, {})), reloadedOn);
  }

  const malformed = { getItem: () => '{not-json' };
  assert.equal(normalizeSettings(storageJson(malformed, key, {})).voice, true);
});

test('failed chat turns are removed while prior successful turns survive', () => {
  const previousUser = { role: 'user', content: 'previous' };
  const previousAssistant = { role: 'assistant', content: 'answered' };
  const history = [{ role: 'system', content: 'system' }, previousUser, previousAssistant];
  const beforeFailure = history.slice();
  history.push({ role: 'user', content: 'will fail' });
  history.push({ role: 'assistant', content: 'never committed' });

  restoreHistory(history, beforeFailure);
  assert.deepEqual(history, [{ role: 'system', content: 'system' }, previousUser, previousAssistant]);
  history.push({ role: 'user', content: 'retry' });
  assert.equal(history.at(-1).content, 'retry');
});

test('unsupported model actions are rejected while supported parameterized actions survive', () => {
  const actions = ['none', 'jump', 'goto:car'];
  assert.equal(isSupportedAction('fly', actions), false);
  assert.equal(isSupportedAction('jump:8', actions), true);
  assert.equal(isSupportedAction('GOTO:CAR', actions), true);
});

test('event backlog stays bounded and rejects the ninth independent event', () => {
  const queue = [];
  for (let i = 0; i < 8; i++) assert.equal(enqueueBounded(queue, `[event] ${i}`, 8), true);
  assert.equal(enqueueBounded(queue, '[event] 8', 8), false);
  assert.equal(queue.length, 8);
});

test('event overflow retains the latest dropped event without growing the queue', () => {
  const queue = ['[event] first queued event'];
  coalesceOverflow(queue, 0, 1, '[event] dropped one');
  coalesceOverflow(queue, 0, 2, '[event] dropped latest');
  assert.equal(queue.length, 1);
  assert.match(queue[0], /2 total/);
  assert.match(queue[0], /dropped latest/);
  assert.doesNotMatch(queue[0], /dropped one/);
});

test('modal overlays consume gameplay shortcuts but retain their close/start keys', () => {
  assert.equal(modalShortcut('stats', 'KeyW'), null);
  assert.equal(modalShortcut('stats', 'Tab'), 'close-stats');
  assert.equal(modalShortcut('board', 'KeyJ'), 'close-board');
  assert.equal(modalShortcut('challenges', 'Digit3'), 'challenge:3');
  assert.equal(modalShortcut('settings', 'KeyO'), 'close-settings');
  assert.equal(modalShortcut('settings', 'KeyW', true), null);
});

test('pet follow/stay/come transitions are isolated and whitelisted', () => {
  let state = normalizePetState({ unlocked: true, name: 'Chopper' });
  state = transitionPet(state, 'summon').state;
  assert.equal(state.visible, true);
  assert.equal(state.state, 'follow');
  state = transitionPet(state, 'stay').state;
  assert.equal(state.state, 'stay');
  state = transitionPet(state, 'come').state;
  assert.equal(state.state, 'follow');
  assert.equal(state.goal, 'come');
  assert.equal(state.relationship.commands, 3);
});

test('invalid pet commands are rejected without changing state', () => {
  const state = transitionPet(normalizePetState({ name: 'Chopper' }), 'fly');
  assert.equal(isSupportedPetCommand('fly'), false);
  assert.equal(state.accepted, false);
  assert.equal(state.reason, 'unknown-pet-command');
  assert.equal(state.state.state, 'idle');
});

test('pet distance and obstacle recovery choose bounded recovery modes', () => {
  assert.equal(petRecovery({ distance: 10, state: 'follow' }), 'come');
  assert.equal(petRecovery({ distance: 2, stuckSeconds: 1, state: 'follow' }), 'reroute');
  assert.equal(petRecovery({ distance: 20, state: 'idle' }), 'none');
});

test('pet reactions are fixed whitelist lines with a derived runtime mood', () => {
  const state = { visible: true, state: 'stay', mood: 'neutral', relationship: {} };
  const tomato = petReaction(state, 'tomato');
  assert.equal(tomato.state.mood, 'worried');
  assert.match(tomato.line, /tomato/i);
  const chat = petReaction(tomato.state, 'chat');
  assert.equal(chat.state.mood, 'happy');
  assert.match(chat.line, /hat/i);
  assert.equal('mood' in serializePetState(chat.state), false);
});

test('pet car enter/exit increments rides and keeps occupancy runtime-only', () => {
  let state = transitionPet(normalizePetState({}), 'summon').state;
  state = transitionPet(state, 'enter_car').state;
  state.inCar = true;
  state.relationship.rides++;
  assert.equal(state.state, 'stay');
  assert.equal(state.goal, 'enter_car');
  assert.equal(state.inCar, true);
  const persisted = serializePetState(state);
  assert.equal('inCar' in persisted, false);
  assert.equal('mood' in persisted, false);
  assert.equal('state' in persisted, false);
  state = transitionPet({ ...state, inCar: true }, 'exit_car').state;
  assert.equal(state.inCar, false);
  assert.equal(state.state, 'stay');
});

test('pet persistence survives reload and malformed values normalize safely', () => {
  const saved = serializePetState(transitionPet(normalizePetState({}), 'summon').state);
  const restored = normalizePetState(saved);
  assert.equal(restored.name, 'Chopper');
  assert.equal(restored.unlocked, true);
  assert.equal(restored.mood, 'neutral');
  assert.equal(restored.state, 'idle');
  assert.equal(normalizePetState('{not-json').name, 'Chopper');
  assert.equal(normalizePetState({ name: '<img src=x>', relationship: { rides: -4 } }).name, 'img srcx');
});

test('model asset failure returns a safe fallback descriptor', () => {
  assert.deepEqual(petAssetFallback({ error: new Error('network <bad>') }), {
    fallback: true, reason: 'network <bad>',
  });
  assert.deepEqual(petAssetFallback({ scene: {} }), { fallback: false, reason: '' });
});

test('Chopper summon introduction uses the bundled audio asset', () => {
  const audioPath = new URL('../web/assets/chopper.mp3', import.meta.url);
  const mainSource = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
  assert.ok(fs.statSync(audioPath).size > 0);
  assert.match(mainSource, /new Audio\('\.\/assets\/chopper\.mp3'\)/);
  assert.match(mainSource, /if \(command === 'summon'\) \{[\s\S]*playChopperIntroduction\(\)/);
});

test('powered Chopper keeps a separate action protocol and safe fallback', () => {
  assert.equal(isSupportedChopperAction('bounce'), true);
  assert.equal(isSupportedChopperAction('drive'), false);
  assert.match(buildChopperSystemPrompt('test-model', 'state: follow'), /separate character from Agent/);
  assert.deepEqual(chopperFallbackReply('Chopper follow me', { command: 'follow' }), {
    say: 'I am right behind you!', action: 'follow', mood: 'happy',
  });
  assert.equal(CHOPPER_ACTIONS.includes('enter_car'), true);
});
