// tiny-gta — one small house, one living NPC driven by your local LLM.
// Voice in (hold T, browser speech recognition) → local model → voice out (speech synthesis).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { NPC_NAME, ACTIONS, setNpcName, buildSystemPrompt } from './persona.js';
import { pickPreferredVoice } from './voice-utils.js';

// ---------------------------------------------------------------- config ---
const CFG = {
  walkSpeed: 2.6,
  runSpeed: 6.0,
  npcWalk: 1.8,
  npcRun: 4.4,
  camDist: 3.6,
  camHeight: 1.55,
  playerRadius: 0.35,
  npcRadius: 0.35,
  talkRange: 3.4,
  punchRange: 1.9,
  gravity: -14,
  // If a character walks backwards, flip its offset by Math.PI.
  modelYaw: { player: 0, npc: Math.PI }, // player=Xbot(+Z), npc=Soldier(-Z)
};

// Named places Raya can walk to (goto:<name>). [x, z]
const PLACES = {
  book:    [4.00, -1.5],
  sofa:    [2.40, -2.6],
  tv:      [2.40, -3.05],
  kitchen: [-3.60, -2.2],
  fridge:  [-3.70, -0.4],
  bed:     [-2.30,  2.6],
  table:   [1.70,  0.8],
  door:    [0.00,  5.2],
  porch:   [0.00,  5.4],
  car:     [6.10,  6.5],
  yard:    [-7.00,  7.5],
  garden:  [-5.00,  8.5],
  lawn:    [-3.00,  9.0],
};
const WANDER_SPOTS = ['sofa', 'kitchen', 'book', 'porch', 'car', 'yard', 'garden'];
const EMOTES = {
  read: '*flips through Crime and Punishment*',
  sit: '*drops onto the sofa*',
  sit_in_car: '*climbs into the Falcon*',
  sit_on_table: '*hops up on the table*',
  lie_on_bed: '*flops onto the bed*',
  cut_grass: '*starts mowing the lawn*',
  water_plants: '*waters the garden plants*',
  watch_tv: '*sits down and watches TV*',
  open_fridge: '*grabs a cold one from the fridge*',
  wash_falcon: '*scrubs the Falcon lovingly*',
  tidy_table: '*stacks everything on the table neatly*',
};

// ------------------------------------------------------------------- dom ---
const $ = (id) => document.getElementById(id);
const bootEl = $('boot'), bootMsg = $('bootmsg'), bootErr = $('booterr');
const promptEl = $('prompt'), statusEl = $('status'), micEl = $('mic');
const bubbleEl = $('bubble'), bubbleTxt = bubbleEl.querySelector('.txt');
bubbleEl.querySelector('.who').textContent = NPC_NAME.toUpperCase();
const chatEl = $('chat'), logEl = $('log'), chatForm = $('chatform'),
      chatInput = $('chatinput'), chatSend = $('chatsend');
const chargeEl = $('charge'), chargeFillEl = $('chargefill'), thinkBubbleEl = $('think');

// ------------------------------------------------------------- renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
// A 1.5x cap looks sharp while avoiding the large frame-time spike that 2x
// causes on Retina laptops (especially with shadows enabled).
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#10182d');
scene.fog = new THREE.Fog('#18233b', 28, 82);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 300);

// ------------------------------------------------- post-processing (bloom) ---
// Subtle UnrealBloom over the night scene — every emissive (windows, lamps,
// headlights, moon, fireflies) grows a soft halo. The MSAA-4 half-float target
// keeps geometry edges clean through the composer; OutputPass applies the
// ACES tone map + sRGB at the end (the renderer skips both when rendering
// into a target). Settings (O) has a "Post-FX" toggle if a machine chokes.
let composer = null;
try {
  const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.5, 0.82));
  composer.addPass(new OutputPass());
} catch { composer = null; /* plain renderer.render fallback below */ }

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer?.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- lights ---
scene.add(new THREE.HemisphereLight('#7188c7', '#25351f', 0.9));
const sun = new THREE.DirectionalLight('#ffe0aa', 2.25);
sun.position.set(24, 18, -14);
sun.castShadow = true;
// 4096 + wider frustum: the expanded lot (z→37) sat outside the old ±30
// shadow camera, so everything out the gate cast no sun shadow at all.
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -40; sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40;
sun.shadow.camera.far = 120;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.035;
scene.add(sun);

// interior warm lights (the house has a roof now)
for (const [x, z, i, d] of [[2.0, -1.5, 14, 9], [-3.5, -1.5, 10, 7]]) {
  const l = new THREE.PointLight('#ffdcb0', i, d, 2);
  l.position.set(x, 2.25, z);
  scene.add(l);
}

// Deep blue gradient sky, stars + moon.  The dome keeps the horizon from
// looking like a flat background while remaining extremely cheap to render.
let skyMesh;
{
  const c = document.createElement('canvas');
  c.width = 32; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#050819');
  grad.addColorStop(0.47, '#14234a');
  grad.addColorStop(0.76, '#52617d');
  grad.addColorStop(1, '#b98c6b');
  g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(190, 32, 18),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), side: THREE.BackSide, fog: false }));
  scene.add(skyMesh);
}

// Image-based lighting: a PMREM of the night sky (+ moon + a warm lamp blob)
// becomes scene.environment, so every MeshStandardMaterial picks up soft sky
// reflections — glossy car paint, subtle rim on characters — instead of the
// flat "diffuse only" look. The env scene is tiny and baked exactly once.
try {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(skyMesh.clone());
  const envMoon = new THREE.Mesh(new THREE.SphereGeometry(9, 8, 8),
    new THREE.MeshBasicMaterial({ color: '#fff3d8' }));
  envMoon.position.set(-70, 48, -80);
  envScene.add(envMoon);
  const envLamp = new THREE.Mesh(new THREE.SphereGeometry(6, 8, 8),
    new THREE.MeshBasicMaterial({ color: '#ffb45e' }));
  envLamp.position.set(30, 26, 50);
  envScene.add(envLamp);
  // far=300: fromScene's default far plane (100) would clip the 190-radius
  // sky dome and the moon right out of the environment map
  scene.environment = pmrem.fromScene(envScene, 0.04, 0.1, 300).texture;
  pmrem.dispose();
} catch { /* no env reflections on this GPU — purely cosmetic */ }

const worldGlow = []; // tiny emissive details that gently breathe at night
const fireflies = [];

// stars + moon
{
  const n = 900, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI * 0.45 + 0.08, r = 140;
    pos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    pos[i * 3 + 1] = Math.sin(e) * r;
    pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({
    color: '#cdd6ff', size: 1.5, sizeAttenuation: false, fog: false,
  })));
  const moon = new THREE.Mesh(new THREE.SphereGeometry(3.2, 16, 16),
    new THREE.MeshBasicMaterial({ color: '#e8ecff', fog: false }));
  moon.position.set(-70, 48, -80);
  scene.add(moon);
  const moonGlow = new THREE.PointLight('#9fb9ff', 1.2, 100, 2);
  moonGlow.position.copy(moon.position);
  scene.add(moonGlow);
}

// --------------------------------------------------- procedural textures ---
function makeTex(base, draw, repeat = [1, 1], size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  draw?.(g);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function speckle(g, colors, n, r0 = 0.6, r1 = 1.8, alpha = 0.5, size = 256) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * (0.4 + Math.random() * 0.6);
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    const r = r0 + Math.random() * (r1 - r0);
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, r, 0, 7);
    g.fill();
  }
  g.globalAlpha = 1;
}
const TEX = {
  // 512px, three layers: broad tonal patches (kills the tiling look), fine
  // speckle, then sparse blade strokes — reads as actual turf up close.
  grass: makeTex('#46603f', (g) => {
    for (let i = 0; i < 70; i++) {
      g.globalAlpha = 0.08 + Math.random() * 0.12;
      g.fillStyle = ['#3a5535', '#547048', '#41603a', '#2f4a2c'][i % 4];
      g.beginPath();
      g.arc(Math.random() * 512, Math.random() * 512, 26 + Math.random() * 74, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    speckle(g, ['#3a5535', '#547048', '#5d7a4b', '#324c2e'], 9500, 0.5, 2.0, 0.5, 512);
    g.strokeStyle = 'rgba(96,128,74,.5)'; g.lineWidth = 1;
    for (let i = 0; i < 800; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      g.beginPath(); g.moveTo(x, y);
      g.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 3);
      g.stroke();
    }
  }, [26, 26], 512),
  asphalt: makeTex('#2b2d32', (g) => speckle(g, ['#232529', '#36383e', '#404248'], 3600, 0.5, 1.6), [22, 2]),
  concrete: makeTex('#83858a', (g) => {
    speckle(g, ['#75777c', '#909298', '#6d6f74'], 2600, 0.5, 1.5);
    g.strokeStyle = 'rgba(60,60,64,.55)'; g.lineWidth = 2;
    for (let x = 0; x <= 256; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke(); }
  }, [8, 8]),
  wood: makeTex('#7a6852', (g) => {
    for (let y = 0; y < 256; y += 21) {
      g.fillStyle = `rgba(40,28,16,${0.25 + Math.random() * 0.2})`;
      g.fillRect(0, y, 256, 2.2);
    }
    speckle(g, ['#6b5a45', '#87755d'], 900, 0.5, 1.4, 0.35);
  }, [5, 4]),
  stucco: makeTex('#d5c8ae', (g) => speckle(g, ['#c9bca1', '#e0d4bc', '#bfb298'], 2200, 0.5, 1.6, 0.4), [3, 1]),
  roof: makeTex('#443b33', (g) => speckle(g, ['#3a322b', '#4f453b'], 2200, 0.5, 1.8), [4, 3]),
};
for (const t of Object.values(TEX)) t.anisotropy = renderer.capabilities.getMaxAnisotropy();

// ------------------------------------------------------- light halo sprites ---
// Soft additive radial-gradient sprites around every practical light. Almost
// free to render, and with bloom on top the lamps finally *glow* instead of
// being bright little boxes floating in the dark.
const HALO_TEX = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,.9)');
  grad.addColorStop(0.35, 'rgba(255,255,255,.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
function addHalo(x, y, z, color, scale, opacity = 0.34) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: HALO_TEX, color, transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  s.position.set(x, y, z);
  s.scale.setScalar(scale);
  scene.add(s);
  return s;
}
addHalo(-70, 48, -80, '#cfe0ff', 30, 0.5); // the moon's atmosphere


// -------------------------------------------------------- world building ---
const colliders = []; // {minX,maxX,minZ,maxZ,h}

function addCollider(x, z, w, d, h) {
  colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, h });
}

function box(w, h, d, color, x, y, z, { solid = true, mat = {} } = {}) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...mat }),
  );
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  scene.add(m);
  if (solid) addCollider(x, z, w, d, h);
  return m;
}

function flat(w, d, x, z, y = 0.01, mat = {}) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({ roughness: 1, ...mat }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// ground / paths (P1-4: removed road, sidewalks, center-line)
flat(80, 80, 0, 0, 0, { map: TEX.grass });
flat(1.9, 9.4, 0, 8.9, 0.014, { map: TEX.concrete });           // path gate→house
flat(3.4, 6.8, 7.5, 6.8, 0.014, { map: TEX.concrete });         // driveway
flat(10, 8, 0, 0, 0.02, { map: TEX.wood });                     // house floor

// house walls (with a roof now — interior is lit by warm lights)
const H = 2.5;
const wallMat = { map: TEX.stucco, mat: {} };
function wall(w, d, x, z) { box(w, H, d, '#ffffff', x, H / 2, z, { mat: { map: TEX.stucco } }); }
wall(4.25, 0.15, -2.875, 4);   // front-left
wall(4.25, 0.15, 2.875, 4);    // front-right (entry gap between)
wall(10.15, 0.15, 0, -4);      // back
wall(0.15, 8, -5, 0);          // west
wall(0.15, 8, 5, 0);           // east
box(10.5, 0.16, 8.5, '#ffffff', 0, 2.62, 0, { solid: false, mat: { map: TEX.roof } }); // flat roof
box(10.7, 0.24, 8.7, '#39322b', 0, 2.5, 0, { solid: false });   // roof trim
// Small front porch; the entry deliberately remains open for easy movement.
flat(3.8, 1.25, 0, 4.65, 0.025, { color: '#6f7278', map: TEX.concrete });
for (const x of [-1.55, 1.55]) {
  box(0.16, 2.45, 0.16, '#e2d6c0', x, 1.22, 4.62, { solid: false });
  box(0.32, 0.16, 0.28, '#57483b', x, 2.43, 4.62, { solid: false });
}
box(3.65, 0.16, 0.75, '#57483b', 0, 2.46, 4.62, { solid: false });
for (const x of [-1.35, -0.85, 0.85, 1.35])
  box(0.08, 0.55, 0.08, '#e2d6c0', x, 0.53, 5.1, { solid: false });
box(3.25, 0.09, 0.09, '#e2d6c0', 0, 0.82, 5.1, { solid: false });
// glowing windows (decor)
for (const [wx, wz] of [[-3.35, 4.085], [3.35, 4.085]]) {
  const window = box(1.05, 1.05, 0.05, '#ffd9a0', wx, 1.48, wz,
    { solid: false, mat: { emissive: '#ffb45e', emissiveIntensity: 0.7, roughness: 0.35 } });
  window.userData.glowBase = 0.7;
  worldGlow.push(window);
  addHalo(wx, 1.48, wz + 0.12, '#ffb45e', 1.4, 0.22);
  box(1.25, 0.1, 0.09, '#473d34', wx, 2.05, 4.12, { solid: false });
  box(0.1, 1.25, 0.09, '#473d34', wx, 1.48, 4.12, { solid: false });
}
const porchLight = new THREE.PointLight('#ffc66f', 13, 7, 2);
porchLight.position.set(-1.72, 2.25, 4.5);
scene.add(porchLight);
const porchBulb = box(0.16, 0.22, 0.16, '#fff0bb', -1.72, 2.25, 4.43,
  { solid: false, mat: { emissive: '#ffbd58', emissiveIntensity: 2.4, roughness: 0.25 } });
porchBulb.userData.glowBase = 2.4;
worldGlow.push(porchBulb);
addHalo(-1.72, 2.25, 4.46, '#ffc66f', 1.8);

// furniture
box(2.2, 0.75, 0.95, '#7d3b3f', 2.4, 0.375, -1.6);              // sofa
box(0.55, 0.28, 0.5, '#8d474b', 1.15, 0.89 - 0.75, -1.6, { solid: false }); // cushion
box(1.6, 0.5, 0.45, '#3a3f4a', 2.4, 0.25, -3.7);                // tv stand
box(1.35, 0.8, 0.08, '#0e131d', 2.4, 1.0, -3.72, { solid: false, mat: { emissive: '#28405e', emissiveIntensity: 0.8 } }); // screen
box(0.35, 1.9, 1.6, '#6b4a2f', 4.65, 0.95, -1.5);               // bookshelf
for (let i = 0; i < 5; i++)                                      // books
  box(0.22, 0.28, 0.18, ['#a34d3f', '#3f6b8a', '#b08d3c', '#4a7d52', '#7b4a7d'][i],
      4.6, 1.15, -2.1 + i * 0.3, { solid: false });
box(0.6, 0.9, 2.6, '#9aa3ab', -4.55, 0.45, -2.2);               // kitchen counter
box(0.7, 1.7, 0.7, '#d5d9de', -4.5, 0.85, -0.4);                // fridge
box(1.5, 0.45, 2.0, '#dfd8c8', -3.6, 0.35, 2.9);                // bed
box(1.5, 0.32, 0.9, '#7d3b3f', -3.6, 0.48, 3.4, { solid: false }); // blanket
box(1.2, 0.72, 0.8, '#6b4a2f', 1.7, 0.36, 1.8);                 // table
flat(2.6, 1.9, 2.4, -2.4, 0.03, { color: '#40525f' });          // rug

// cars — Raya's Falcon + parked neighbors
function buildCar(x, z, color, ry = 0) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  scene.add(g);
  const part = (w, h, d, c, px, py, pz, extra = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, ...extra }));
    m.position.set(px, py, pz); m.castShadow = true; g.add(m);
  };
  // glossy paint: metalness + the PMREM night sky reflecting off the panels
  const paint = { metalness: 0.55, roughness: 0.32, envMapIntensity: 1.4 };
  part(1.85, 0.55, 4.1, color, 0, 0.62, 0, paint);
  // CONVERTIBLE: open top (no roof, no pillars) so anyone in the car is fully
  // visible — the old greenhouse roof clipped through a standing passenger.
  part(1.55, 0.42, 0.07, '#20303f', 0, 1.1, 0.72, { transparent: true, opacity: 0.35, roughness: 0.1 }); // low windshield
  part(1.6, 0.06, 0.07, '#c6cbd2', 0, 1.32, 0.72, { metalness: 0.8, roughness: 0.25 });                  // windshield top rail
  part(1.45, 0.3, 0.08, color, 0, 1.04, -1.05, paint);         // rear seat back / bed wall
  part(1.6, 0.12, 0.25, '#e8e0c8', 0, 0.62, 2.0, { emissive: '#c8b87a', emissiveIntensity: 0.7 });
  part(1.58, 0.1, 0.18, '#8c1719', 0, 0.63, -2.03, { emissive: '#691012', emissiveIntensity: 0.55 });
  for (const sx of [-0.78, 0.78]) {
    part(0.07, 0.08, 3.25, '#d7dbe1', sx, 0.72, 0, { metalness: 0.8, roughness: 0.22 });
  }
  for (const [wx, wz] of [[-0.92, 1.35], [0.92, 1.35], [-0.92, -1.35], [0.92, -1.35]]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.25, 14),
      new THREE.MeshStandardMaterial({ color: '#15161a', roughness: 0.9 }));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz);
    wheel.castShadow = true;
    g.add(wheel);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.265, 12),
      new THREE.MeshStandardMaterial({ color: '#c6cbd2', metalness: 0.85, roughness: 0.24 }));
    hub.rotation.z = Math.PI / 2;
    hub.position.set(wx, 0.34, wz);
    g.add(hub);
  }
  const along = Math.abs(Math.sin(ry)) > 0.5; // rotated 90° → long side on x
  addCollider(x, z, along ? 4.2 : 1.9, along ? 1.9 : 4.2, 1.4);
  return g;
}
const falconColliderIdx = colliders.length;       // buildCar pushes one collider
const falconGroup = buildCar(7.5, 6.5, '#b7443b'); // the Falcon — drivable! (F)
// P1-4: removed street-parked neighbor cars

// fence with a WIDE front gate. The car's collision check pads every collider
// by ~1.1m, so the gap must be ±4m for a comfortable drive-through lane.
const F = '#8b7f6b';
box(24, 1.0, 0.12, F, 0, 0.5, -9);              // back
box(8, 1.0, 0.12, F, -8, 0.5, 13);              // front-left  (x −12 … −4)
box(8, 1.0, 0.12, F, 8, 0.5, 13);               // front-right (x   4 … 12)
box(0.12, 1.0, 22, F, -12, 0.5, 2);             // west
box(0.12, 1.0, 22, F, 12, 0.5, 2);              // east
// gate posts flanking the opening
for (const gx of [-4, 4]) box(0.28, 1.5, 0.28, '#6f6555', gx, 0.75, 13, { solid: false });

// ---------------------- the drivable lot beyond the gate (world expansion) ----
// A big open concrete lot out front where you can take him for a spin. The
// props here are solid colliders — crash into them and the Falcon takes damage.
flat(8, 24, 0, 25, 0.02, { map: TEX.concrete });                 // driveway out the gate
flat(56, 40, 0, 25, 0.012, { color: '#5c6b52', map: TEX.grass }); // open field
flat(60, 8, 0, 34.5, 0.03, { map: TEX.asphalt || TEX.concrete }); // a road across the far end

// street lamps down the lot (tall, solid)
function streetLamp(x, z) {
  box(0.22, 4.2, 0.22, '#3b3f47', x, 2.1, z);                     // pole (solid collider)
  box(0.7, 0.22, 0.7, '#2b2f36', x, 4.15, z, { solid: false });
  const bulb = box(0.5, 0.16, 0.5, '#ffdf9c', x, 4.0, z,
    { solid: false, mat: { emissive: '#ffbe57', emissiveIntensity: 1.6 } });
  bulb.userData.glowBase = 1.6; worldGlow.push(bulb);
  addHalo(x, 4.0, z, '#ffd489', 2.4);
  const l = new THREE.PointLight('#ffcf86', 10, 12, 2); l.position.set(x, 3.9, z); scene.add(l);
}
for (const [x, z] of [[-9, 18], [9, 18], [-9, 30], [9, 30]]) streetLamp(x, z);

// crashable street furniture
box(0.4, 1.1, 0.4, '#c0392b', -6, 0.55, 16);                     // fire hydrant-ish
box(0.5, 1.3, 0.35, '#2e6da4', 6, 0.65, 16);                     // mailbox
box(2.0, 0.5, 0.6, '#8a6d3b', 4.5, 0.45, 22);                    // bench
box(2.0, 0.55, 0.55, '#8a6d3b', -4.5, 0.45, 26);                 // crate stack
box(0.9, 0.9, 0.9, '#b5942f', 8, 0.45, 24);                      // wooden crate
box(0.9, 0.9, 0.9, '#b5942f', -8, 0.45, 20);                     // wooden crate
for (const [x, z, s] of [[-13, 22, 1.2], [13, 26, 1.1], [-11, 32, 1], [11, 20, 1.15]]) {
  // reuse the tree look via shrub-scale trunks
  box(0.4, 2.4, 0.4, '#5a4632', x, 1.2, z);                      // trunk (solid)
  const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5 * s, 1),
    new THREE.MeshStandardMaterial({ color: '#3f6b3a', roughness: 1 }));
  canopy.position.set(x, 3.0, z); canopy.castShadow = true; scene.add(canopy);
}
// traffic cones — pure decor (non-solid), just scatter for flavor
for (const [x, z] of [[-2, 16], [2, 16], [-1, 20], [1.5, 24], [-2.5, 28]]) {
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 10),
    new THREE.MeshStandardMaterial({ color: '#e8622a', roughness: 0.7 }));
  cone.position.set(x, 0.25, z); cone.castShadow = true; scene.add(cone);
}

// -------------------------------------------- AI-meme photo frames (decor) ----
// Procedurally drawn (CSP-safe, no external images) posters of AI brands + dev
// memes, hung on the interior walls. The NPC is "powered by" one of these, and
// it makes the house feel like a developer's shrine.
function memeFrame(draw, x, y, z, ry, w = 1.25, h = 0.95) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  draw(g, 320, 240);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }));
  pic.position.set(x, y, z); pic.rotation.y = ry; scene.add(pic);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.11, h + 0.11, 0.04),
    new THREE.MeshStandardMaterial({ color: '#241a12', roughness: 0.7 }));
  frame.position.set(x - Math.sin(ry) * 0.025, y, z - Math.cos(ry) * 0.025);
  frame.rotation.y = ry; frame.castShadow = true; scene.add(frame);
}
// shared helpers for the little canvas drawings
const centerText = (g, s, size, y, color, font = 'bold') => {
  g.fillStyle = color; g.textAlign = 'center';
  g.font = `${font} ${size}px -apple-system, "Segoe UI", sans-serif`;
  g.fillText(s, 160, y);
};
const MEMES = [
  (g) => { g.fillStyle = '#da7756'; g.fillRect(0, 0, 320, 240); // Claude
    g.fillStyle = '#fff'; g.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; g.moveTo(160, 95); g.lineTo(160 + Math.cos(a) * 34, 95 + Math.sin(a) * 34); }
    g.lineWidth = 7; g.strokeStyle = '#fff'; g.stroke();
    centerText(g, 'Claude', 46, 175, '#2b1b12'); centerText(g, 'my brain lives here', 17, 205, '#5b3a2a', ''); },
  (g) => { g.fillStyle = '#0f7a63'; g.fillRect(0, 0, 320, 240); // ChatGPT
    g.strokeStyle = '#fff'; g.lineWidth = 8; g.beginPath(); g.arc(160, 92, 34, 0, 7); g.stroke();
    centerText(g, 'ChatGPT', 44, 172, '#fff'); centerText(g, '"as an AI model…"', 18, 204, '#bfe9dd', ''); },
  (g) => { const grd = g.createLinearGradient(0, 0, 320, 240); grd.addColorStop(0, '#4b6bd6'); grd.addColorStop(1, '#8b53c9');
    g.fillStyle = grd; g.fillRect(0, 0, 320, 240); centerText(g, '✦ Gemini', 46, 110, '#fff'); // Gemini
    centerText(g, 'now with 1M context', 18, 150, '#e5e0ff', ''); centerText(g, '(still forgot line 2)', 16, 178, '#cfc7f5', ''); },
  (g) => { g.fillStyle = '#12151d'; g.fillRect(0, 0, 320, 240); // prompt engineer
    centerText(g, '🧑‍💻', 70, 110, '#fff'); centerText(g, 'PROMPT ENGINEER', 26, 165, '#ffd479');
    centerText(g, 'yells at computer, gets paid', 15, 198, '#8b93a8', ''); },
  (g) => { g.fillStyle = '#e0563b'; g.fillRect(0, 0, 320, 240); // this is fine
    centerText(g, '🔥🐶🔥', 54, 120, '#fff'); centerText(g, '"prod is down"', 30, 175, '#2b120c');
    centerText(g, 'this is fine', 22, 208, '#3a1810', ''); },
  (g) => { g.fillStyle = '#1b2430'; g.fillRect(0, 0, 320, 240); // AI won't replace you
    centerText(g, 'AI won\'t take your job', 22, 100, '#7fc76f');
    centerText(g, 'a dev USING AI will', 22, 140, '#ffd479');
    centerText(g, '— every LinkedIn post', 15, 190, '#8b93a8', ''); },
  (g) => { g.fillStyle = '#0e1a12'; g.fillRect(0, 0, 320, 240); // works on my machine
    g.strokeStyle = '#7fc76f'; g.lineWidth = 6; g.beginPath(); g.arc(160, 88, 52, 0, 7); g.stroke();
    centerText(g, '✓', 60, 108, '#7fc76f'); centerText(g, 'WORKS ON', 26, 172, '#e8f6e8');
    centerText(g, 'MY MACHINE™', 26, 202, '#e8f6e8'); },
  (g) => { g.fillStyle = '#0b0e14'; g.fillRect(0, 0, 320, 240); // 404 motivation
    g.fillStyle = '#22c55e'; g.font = 'bold 20px Menlo, monospace'; g.textAlign = 'left';
    g.fillText('$ motivation', 24, 84); g.fillText('bash: 404 not found', 24, 122);
    g.fillText('$ coffee --force', 24, 172); g.fillStyle = '#86efac'; g.fillText('▮', 24, 206); },
  (g) => { const grd = g.createLinearGradient(0, 0, 0, 240); grd.addColorStop(0, '#3b1d54'); grd.addColorStop(1, '#151022');
    g.fillStyle = grd; g.fillRect(0, 0, 320, 240); centerText(g, '🚀🔥', 58, 105, '#fff'); // deployed friday
    centerText(g, 'DEPLOYED FRIDAY', 27, 165, '#ffd479'); centerText(g, '5:59 PM · see you monday', 16, 198, '#c9b8e8', ''); },
];
// hang them: back wall (faces +z into room) and side walls
memeFrame(MEMES[0], -3.4, 1.6, -3.87, 0);
memeFrame(MEMES[3], 0, 1.6, -3.87, 0);
memeFrame(MEMES[5], 3.4, 1.6, -3.87, 0);
memeFrame(MEMES[1], -4.87, 1.55, -0.5, Math.PI / 2);   // west wall
memeFrame(MEMES[2], -4.87, 1.55, 1.6, Math.PI / 2);
memeFrame(MEMES[4], 4.87, 1.55, 1.2, -Math.PI / 2);    // east wall
// interior extras — the front wall was bare
memeFrame(MEMES[7], -2.9, 1.6, 3.92, Math.PI);
memeFrame(MEMES[8], 2.9, 1.6, 3.92, Math.PI);
// one by the front door, outside
memeFrame(MEMES[6], 1.7, 1.7, 4.078, 0, 0.8, 0.55);

// —— the shrine spills outside: posters along the boundary fence ——
// (fence is 1m tall, so these are small landscape prints)
memeFrame(MEMES[6], -6, 0.52, -8.93, 0, 0.9, 0.62);            // back fence
memeFrame(MEMES[7], 0, 0.52, -8.93, 0, 0.9, 0.62);
memeFrame(MEMES[8], 6, 0.52, -8.93, 0, 0.9, 0.62);
memeFrame(MEMES[7], -11.93, 0.52, 3.5, Math.PI / 2, 0.9, 0.62); // west fence
memeFrame(MEMES[8], 11.93, 0.52, -2, -Math.PI / 2, 0.9, 0.62);  // east fence

// —— bumper stickers & decals on the Falcon (attached, so they ride along) ——
function carSticker(draw, lx, ly, lz, ry, w, h, flat = false) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  draw(c.getContext('2d'), 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1 }));
  m.position.set(lx, ly, lz);
  if (flat) m.rotation.x = -Math.PI / 2;
  else m.rotation.y = ry;
  falconGroup.add(m);
}
const stickerBase = (g, w, h, bg) => {
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
};
carSticker((g, w) => { stickerBase(g, w, 128, '#1d2533');            // rear bumper
  g.fillStyle = '#ffd479'; g.textAlign = 'center'; g.font = 'bold 26px -apple-system, sans-serif';
  g.fillText('MY OTHER CAR', w / 2, 52); g.fillText('IS A NEURAL NET', w / 2, 88);
}, 0, 0.78, -2.056, Math.PI, 1.05, 0.26);
carSticker((g, w) => { stickerBase(g, w, 128, '#2a1a3d');            // hood decal
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 40px sans-serif'; g.fillText('⚡🪙⚡', w / 2, 56);
  g.fillStyle = '#e8d8ff'; g.font = 'bold 22px sans-serif'; g.fillText('POWERED BY TOKENS', w / 2, 96);
}, 0, 0.901, 1.15, 0, 0.72, 0.44, true);
for (const sx of [-1, 1]) carSticker((g, w) => { stickerBase(g, w, 128, '#12233a'); // door decals
  g.fillStyle = '#7fc76f'; g.textAlign = 'center'; g.font = 'bold 30px sans-serif'; g.fillText('TOKEN EATER', w / 2, 62);
  g.fillStyle = '#9fd0ff'; g.font = '18px sans-serif'; g.fillText('0 emissions · 100% drama', w / 2, 95);
}, sx * 0.928, 0.66, 0.45, sx * Math.PI / 2, 0.78, 0.3);

// P1-4: removed neighbor houses — replaced with garden
// --------------------------------------------------------- garden (P1-4) ---
// flower beds (colored icosahedra) — pluckable (P key), and he will NOT like it
const flowerColors = ['#e84393', '#fd79a8', '#fab1a0', '#ffeaa7', '#a29bfe', '#74b9ff'];
const flowers = [];
for (let i = 0; i < 8; i++) {
  const fx = -8 + i * 1.4 + (Math.random() - 0.5) * 0.4;
  const fz = 8.5 + (Math.random() - 0.5) * 1.2;
  const flower = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.18 + Math.random() * 0.12, 0),
    new THREE.MeshStandardMaterial({ color: flowerColors[i % flowerColors.length], roughness: 0.8 })
  );
  flower.position.set(fx, 0.2 + Math.random() * 0.08, fz);
  flower.castShadow = true;
  scene.add(flower);
  // stem
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.03, 0.25, 5),
    new THREE.MeshStandardMaterial({ color: '#2d6a22', roughness: 1 })
  );
  stem.position.set(fx, 0.1, fz);
  scene.add(stem);
  flowers.push({ head: flower, stem, x: fx, z: fz, plucked: false });
}

// hedge boxes along the garden edge — kept WEST of the gate lane. The old row
// ran to x=1.4 which (with the car's 1.1m collision pad) walled off the gate
// entirely: the Falcon could never leave the yard.
for (const hx of [-10, -7.4, -4.8]) {
  box(1.4, 0.7, 0.6, '#2d5a1e', hx, 0.35, 10.2, { solid: true });
}
// two hedges flank the gate from OUTSIDE the drive lane (decor + guidance)
for (const hx of [-5.2, 5.2]) {
  box(1.4, 0.7, 0.6, '#2d5a1e', hx, 0.35, 12.3, { solid: true });
}

// lawn area (slightly varied grass patches — targets for cut_grass)
for (let i = 0; i < 6; i++) {
  const lx = -5 + i * 1.8 + (Math.random() - 0.5) * 0.5;
  const lz = 7 + Math.random() * 2;
  flat(1.4, 1.4, lx, lz, 0.015, { color: '#4a7a3f' });
}

// vegetable patch (for water_plants target)
flat(3, 2, -6, 8, 0.02, { color: '#5a4a32' });
for (let i = 0; i < 4; i++) {
  const veg = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.14, 0),
    new THREE.MeshStandardMaterial({ color: '#4a8c3f', roughness: 1 })
  );
  veg.position.set(-7 + i * 0.8, 0.15, 8);
  veg.castShadow = true;
  scene.add(veg);
}

// Denser planting breaks up the large flat lawn and gives the garden a soft,
// lived-in edge without adding texture downloads.
function shrub(x, z, scale = 1, tint = '#315f2d') {
  const group = new THREE.Group();
  for (const [ox, oy, oz, r] of [[0, .34, 0, .42], [.28, .26, .1, .3], [-.27, .23, -.08, .28]]) {
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(r * scale, 1),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.95 }));
    leaf.position.set(ox * scale, oy * scale, oz * scale);
    leaf.castShadow = true; leaf.receiveShadow = true; group.add(leaf);
  }
  group.position.set(x, 0, z); scene.add(group);
}
for (const [x, z, s] of [[-10.3, 8.8, 1], [-8.9, 7, .8], [-7.1, 10.7, .85], [8.8, 8.8, 1], [9.8, 5.8, .75], [6.8, 10.7, .7]]) shrub(x, z, s);

// Distant silhouette hills — big dark icosahedra sunk into the fog band so the
// horizon reads as a misty treeline instead of a flat plane meeting the sky.
for (const [hx, hz, hr, hh] of [[-62, -32, 26, 8], [58, -46, 30, 9], [72, 22, 24, 7],
                                [-72, 28, 28, 8], [18, -72, 32, 10], [-34, -66, 25, 7], [64, 60, 30, 8]]) {
  const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(hr, 1),
    new THREE.MeshStandardMaterial({ color: '#1c2a25', roughness: 1 }));
  hill.scale.y = hh / hr;
  hill.position.set(hx, 0, hz);
  scene.add(hill);
}

// Instanced grass tufts: crossed alpha-tested blade planes scattered over the
// yard and field. One InstancedMesh (≤840 instances), no shadows cast — the
// flat lawn stops looking like a green carpet for almost zero frame cost.
{
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = '#55803f'; g.lineWidth = 3; g.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const bx = 8 + i * 8;
    g.beginPath(); g.moveTo(bx, 64);
    g.quadraticCurveTo(bx + (Math.random() - 0.5) * 10, 30,
                       bx + (Math.random() - 0.5) * 16, 4 + Math.random() * 12);
    g.stroke();
  }
  const bladeTex = new THREE.CanvasTexture(c);
  const bladeGeo = new THREE.PlaneGeometry(0.55, 0.34);
  bladeGeo.translate(0, 0.17, 0); // pivot at the roots
  const bladeMat = new THREE.MeshStandardMaterial({
    map: bladeTex, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
    roughness: 1, color: '#87a86f',
  });
  const tuftOk = (x, z) => {
    if (Math.abs(x) < 5.6 && Math.abs(z) < 4.6) return false;    // house
    if (Math.abs(x) < 1.3 && z > 4 && z < 13.8) return false;    // front path
    if (x > 5.5 && x < 9.6 && z > 3.2 && z < 10.4) return false; // driveway
    if (Math.abs(x) < 4.3 && z > 13 && z < 37) return false;     // lot driveway
    if (z > 30.2) return false;                                   // road
    return true;
  };
  const N_TUFTS = 420;
  const tufts = new THREE.InstancedMesh(bladeGeo, bladeMat, N_TUFTS * 2);
  tufts.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let ti = 0;
  for (let i = 0; i < N_TUFTS; i++) {
    let tx = 0, tz = 0, ok = false;
    for (let tries = 0; tries < 12 && !ok; tries++) {
      if (i % 5 < 3) { tx = -11.5 + Math.random() * 23; tz = -8 + Math.random() * 20; }  // yard
      else { tx = -26 + Math.random() * 52; tz = 13.5 + Math.random() * 16; }            // field
      ok = tuftOk(tx, tz);
    }
    if (!ok) continue;
    const ry = Math.random() * Math.PI, ts = 0.7 + Math.random() * 0.7;
    for (const rot of [0, Math.PI / 2]) {
      dummy.position.set(tx, 0, tz);
      dummy.rotation.set(0, ry + rot, 0);
      dummy.scale.setScalar(ts);
      dummy.updateMatrix();
      tufts.setMatrixAt(ti++, dummy.matrix);
    }
  }
  tufts.count = ti;
  tufts.instanceMatrix.needsUpdate = true;
  scene.add(tufts);
}

// Small warm fireflies make the night garden feel alive. Their positions are
// updated in the render loop, rather than allocating particles every frame.
for (let i = 0; i < 22; i++) {
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 6, 6),
    new THREE.MeshBasicMaterial({ color: '#ffe59b', transparent: true, opacity: 0.8, fog: false }));
  const x = -10 + Math.random() * 19, z = 5.7 + Math.random() * 5.6;
  dot.position.set(x, 0.35 + Math.random() * 1.15, z);
  scene.add(dot);
  fireflies.push({ mesh: dot, x, y: dot.position.y, z, phase: Math.random() * Math.PI * 2, speed: .55 + Math.random() * .75 });
}

// garden light
const gardenLight = new THREE.PointLight('#c8e8a0', 6, 12, 2);
gardenLight.position.set(-5, 2.5, 8);
scene.add(gardenLight);
addHalo(-5, 2.5, 8, '#c8e8a0', 1.6, 0.24);

// trees + street lamps
function tree(x, z, s = 1) {
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16 * s, 0.22 * s, 1.6 * s, 8),
    new THREE.MeshStandardMaterial({ color: '#5a4632' }));
  trunk.position.set(x, 0.8 * s, z); trunk.castShadow = true; scene.add(trunk);
  for (const [ox, oy, oz, r] of [[0, 2.1, 0, 1.1], [0.5, 1.6, 0.3, 0.75], [-0.5, 1.7, -0.2, 0.7]]) {
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1),
      new THREE.MeshStandardMaterial({ color: '#3a5c36', roughness: 1 }));
    puff.position.set(x + ox * s, oy * s, z + oz * s); puff.castShadow = true; scene.add(puff);
  }
  addCollider(x, z, 0.5, 0.5, 1.2);
}
tree(-8, 8); tree(9.5, -5.5, 1.2);  // P1-4: kept 2 trees, removed far-field ones

function lamp(x, z) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 3.2, 8),
    new THREE.MeshStandardMaterial({ color: '#3a3f45' }));
  pole.position.set(x, 1.6, z); pole.castShadow = true; scene.add(pole);
  box(0.5, 0.16, 0.24, '#3a3f45', x, 3.2, z - 0.14, { solid: false });
  const l = new THREE.PointLight('#ffc46b', 24, 15, 2);
  l.position.set(x, 3.0, z - 0.3);
  scene.add(l);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8),
    new THREE.MeshStandardMaterial({ color: '#fff0b8', emissive: '#ffb84e', emissiveIntensity: 2.6 }));
  bulb.userData.glowBase = 2.6;
  bulb.position.set(x, 3.0, z - 0.3); scene.add(bulb); worldGlow.push(bulb);
  addHalo(x, 3.0, z - 0.3, '#ffcf86', 2.1);
  addCollider(x, z, 0.24, 0.24, 3.2);
}
lamp(4.8, 11.4);  // beside the gate, OUT of the drive lane (at 1.9 it blocked the car)

// ------------------------------------------------------------- collision ---
function resolveCircle(pos, r) {
  for (const c of colliders) {
    const nx = Math.max(c.minX - r, Math.min(pos.x, c.maxX + r));
    const nz = Math.max(c.minZ - r, Math.min(pos.z, c.maxZ + r));
    if (nx === pos.x && nz === pos.z) {
      const dl = pos.x - (c.minX - r), dr = (c.maxX + r) - pos.x;
      const dt = pos.z - (c.minZ - r), db = (c.maxZ + r) - pos.z;
      const m = Math.min(dl, dr, dt, db);
      if (m === dl) pos.x = c.minX - r;
      else if (m === dr) pos.x = c.maxX + r;
      else if (m === dt) pos.z = c.minZ - r;
      else pos.z = c.maxZ + r;
    }
  }
  // expanded lot: the yard opens out the front gate into a big drivable area
  pos.x = Math.max(-35, Math.min(35, pos.x));
  pos.z = Math.max(-8.6, Math.min(37, pos.z));
}

function pointHits(x, z, r) {
  for (const c of colliders) {
    if (c.h > 0.4 && x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) return true;
  }
  return false;
}

function pointBlocked(x, z) { // camera obstruction: tall things only
  for (const c of colliders) {
    if (c.h > 1.5 && x > c.minX - 0.1 && x < c.maxX + 0.1 && z > c.minZ - 0.1 && z < c.maxZ + 0.1) return true;
  }
  return false;
}

function segClear(ax, az, bx, bz, r = 0.42) {
  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(2, Math.ceil(dist / 0.25));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (pointHits(ax + dx * t, az + dz * t, r)) return false;
  }
  return true;
}

// If a walk target lands inside/too close to a collider (e.g. "come here"
// while the player stands against a wall), snap it to the nearest clear spot —
// otherwise he grinds into the wall trying to reach an unreachable point.
function findClearNear(x, z) {
  if (!pointHits(x, z, 0.45)) return [x, z];
  for (let r = 0.5; r <= 3.2; r += 0.45) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const nx = x + Math.cos(ang) * r, nz = z + Math.sin(ang) * r;
      if (nx < -34.5 || nx > 34.5 || nz < -8.5 || nz > 36.5) continue;
      if (!pointHits(nx, nz, 0.45)) return [nx, nz];
    }
  }
  return [x, z];
}

// ------------------------------------------------------ navigation graph ---
// Hand-placed nodes in open space; edges are auto-derived with a clearance
// test at boot, so the graph can never disagree with the actual geometry.
// P1-4: regenerated for smaller lot — removed street node, added garden nodes
const NAV = [
  [0, 0.2], [2.2, -0.6], [-3.2, -2.2], [-3.4, 1.1], [4.0, -1.5],  // indoors
  [0, 3.0], [0, 5.3],                                              // doorway
  [0, 9.2],                                                        // path
  [-7, 7.5], [6, 9.6], [6.1, 6.5], [5.9, 2.2],                     // yard W, drive, car, east corridor
  [8.8, 0.5], [-8, 0.5], [0, -6.3], [-8, -6.2], [7.8, -6.2],       // around the house
  [-5, 8.5], [-3, 9.0], [-6, 8.0],                                  // garden, lawn, veg patch
  [0, 16], [0, 25], [-9, 25], [9, 25], [0, 33],                     // open lot out the gate
];
const NAV_ADJ = [];
function buildNav() {
  for (let i = 0; i < NAV.length; i++) NAV_ADJ.push([]);
  for (let i = 0; i < NAV.length; i++) {
    for (let j = i + 1; j < NAV.length; j++) {
      if (segClear(NAV[i][0], NAV[i][1], NAV[j][0], NAV[j][1])) {
        NAV_ADJ[i].push(j); NAV_ADJ[j].push(i);
      }
    }
  }
}

function visibleNodes(x, z) {
  const out = [];
  for (let i = 0; i < NAV.length; i++) {
    if (segClear(x, z, NAV[i][0], NAV[i][1])) out.push(i);
  }
  return out;
}

// Returns an array of Vector3 waypoints from `from` to [tx, tz].
function routeTo(from, tx, tz) {
  const end = new THREE.Vector3(tx, 0, tz);
  if (segClear(from.x, from.z, tx, tz)) return [end];
  const entries = visibleNodes(from.x, from.z);
  const exits = new Set(visibleNodes(tx, tz));
  if (!entries.length || !exits.size) return [end];
  const prev = new Array(NAV.length).fill(-2);
  const queue = [];
  for (const e of entries) { prev[e] = -1; queue.push(e); }
  let found = -1;
  while (queue.length) {
    const n = queue.shift();
    if (exits.has(n)) { found = n; break; }
    for (const m of NAV_ADJ[n]) {
      if (prev[m] === -2) { prev[m] = n; queue.push(m); }
    }
  }
  if (found === -1) return [end];
  const chain = [];
  for (let n = found; n !== -1; n = prev[n]) chain.unshift(new THREE.Vector3(NAV[n][0], 0, NAV[n][1]));
  chain.push(end);
  return chain;
}

// -------------------------------------------------------------- zones ---
const inHouse = (p) => Math.abs(p.x) < 5 && Math.abs(p.z) < 4;
function roomOf(p) {
  if (inHouse(p)) {
    if (p.x < -2 && p.z < 0.8) return 'kitchen';
    if (p.x < -2) return 'bedroom corner';
    return 'living room';
  }
  if (Math.abs(p.x) < 1.6 && p.z > 4 && p.z <= 6.2) return 'front porch';
  // the Falcon MOVES — "next to the Falcon" must track its live position
  const fp = falconGroup.position;
  if (Math.hypot(p.x - fp.x, p.z - fp.z) < 4) return 'next to the Falcon';
  if (p.z > 13) return 'open lot out front';
  if (p.x > 5 && p.z > 3.5 && p.z < 9.8) return 'driveway';
  return 'yard';
}

// --------------------------------------------------------- animations ---
class CharacterAnim {
  constructor(root, clips) {
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {};
    for (const c of clips) this.actions[c.name.toLowerCase()] = this.mixer.clipAction(c);
    this.current = null;
    this.gestureUntil = 0;
    this.list = Object.values(this.actions);
    // a guaranteed fallback pose so the rig can never snap to bind (the T-pose)
    this.idle = this.find(['idle']) || this.list[0] || null;
  }
  find(names) {
    for (const n of names) {
      for (const key of Object.keys(this.actions)) {
        if (key.includes(n)) return this.actions[key];
      }
    }
    return null;
  }
  // Fade an action out AND STOP it once the fade lands. A weight-0 action
  // left "running" keeps applying its property bindings every frame, and a
  // binding under total weight < 1 blends in the ORIGINAL (bind/T) pose —
  // so every abandoned fade-out quietly stamped the T-pose over whatever
  // was playing. This zombie is the root cause of the recurring T-pose.
  _fadeOutStop(a, fade) {
    a.fadeOut(fade);
    clearTimeout(a._stopTimer);
    a._stopTimer = setTimeout(() => { if (a !== this.current) a.stop(); }, fade * 1000 + 80);
  }
  _play(a, fade, freeze) {
    clearTimeout(a._stopTimer); // revived mid-stop — cancel the pending stop
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.timeScale = freeze ? 0 : 1;
    a.reset().fadeIn(fade).play();
    this.current = a;
  }
  setBase(names, fade = 0.22) {
    if (performance.now() < this.gestureUntil) return;
    // fall back to idle when the requested clip is missing — never leave the
    // rig with nothing playing (that's what produced the T-pose)
    const a = this.find(names) || this.idle;
    if (!a || a === this.current) return;
    if (this.current) this._fadeOutStop(this.current, fade);
    this._play(a, fade, false);
  }
  // freeze=true holds the clip's first frame as a static pose (e.g. the
  // crouch-walk's stance doubles as a "sitting" pose on furniture)
  gesture(names, secs = 1.3, freeze = false) {
    // A HELD pose (frozen seated crouch on the sofa / in the car) must never
    // be broken by a transient gesture like "talking" — that stood him up
    // through the furniture mid-sentence, the reported "T-shape while
    // speaking". Held poses win; freeze gestures may replace each other.
    const held = this.current && this.current.enabled && this.current.timeScale === 0 &&
                 performance.now() < this.gestureUntil;
    if (held && !freeze) return false;
    const a = this.find(names);
    if (!a) return false;
    if (this.current && this.current !== a) this._fadeOutStop(this.current, 0.15);
    this._play(a, 0.15, freeze);
    this.gestureUntil = performance.now() + secs * 1000;
    return true;
  }
  update(dt) {
    this.mixer.update(dt);
    // T-POSE WATCHDOG: the rig snaps to its bind pose (the T-pose) the moment
    // nothing is driving its bones — a stopped action or a crossfade gap.
    // `getEffectiveWeight()` is stale on inactive actions, so we check whether
    // `current` is genuinely alive: running normally, OR a legit frozen held
    // pose (timeScale 0). If it's dead, snap idle on AND re-tick the mixer with
    // dt=0 so the pose is recomputed THIS frame — render() runs right after us,
    // so without the re-tick the T-pose would flash for one frame before the
    // fix took effect (the "T-pose that fixes itself" you saw).
    if (!this.idle) return;
    const c = this.current;
    const frozenPose = c && c.enabled && c.timeScale === 0;
    let alive = c && (c.isRunning() || frozenPose);
    // An action that is "running" with its weight stuck at 0 (an interrupted
    // crossfade) renders the exact same T-pose as a dead one. Give a normal
    // fade-in 400ms to produce weight, then treat it as dead and recover.
    if (alive && !frozenPose && c.getEffectiveWeight() === 0) {
      if (!this._zeroSince) this._zeroSince = performance.now();
      else if (performance.now() - this._zeroSince > 400) { alive = false; this._zeroSince = 0; }
    } else this._zeroSince = 0;
    if (!alive) {
      this.idle.reset();
      this.idle.enabled = true;
      this.idle.timeScale = 1;
      this.idle.setEffectiveWeight(1);
      this.idle.play();
      this.current = this.idle;
      this.mixer.update(0); // recompute bones now, before this frame renders
    }
  }
}

// Ready Player Me mocap library (CC-licensed, Mixamo-compatible skeleton).
// Tracks are rotation-only after stripping, so they retarget onto any
// mixamorig rig — including any Mixamo character you drop in later.
const MOCAP_FILES = {
  idle: 'M_Standing_Idle_001',
  walk: 'M_Walk_001',
  run: 'M_Run_001',
  jump: 'M_Walk_Jump_002',
  crawl: 'M_Crouch_Walk_003',
  dance: 'M_Dances_001',
  talking: 'M_Talking_Variations_001',
  falling: 'M_Falling_Idle_002',
};

// Returns { rig, clips }: one shared RPM armature + raw clips (original track
// names, positions intact) — bakeRetarget() plays them on the rig and re-derives
// correct rotations per target skeleton, so ANY rig gets real mocap.
// Headlessly verified on the Soldier NPC: 12/12 pose samples upright.
async function loadMocapLib(loader) {
  let rig = null;
  const clips = [];
  await Promise.all(Object.entries(MOCAP_FILES).map(async ([name, file]) => {
    try {
      const g = await loader.loadAsync(`./assets/anim/${file}.glb`);
      const clip = g.animations[0];
      clip.name = name;
      clips.push(clip);
      if (!rig) rig = g.scene; // same armature in every file — keep the first
    } catch { /* clip missing — procedural fallbacks cover it */ }
  }));
  return rig && clips.length ? { rig, clips } : null;
}

// Retarget the RPM mocap library onto whatever rig loaded — auto-picking the
// method from the TARGET's bind pose, because the two rig families need
// opposite handling:
//
//   • T-POSE-bind rigs (three.js Soldier/Xbot NPC rest with arms straight out,
//     hand-spread ≈ 1.4). The RPM source rests arms-DOWN. A delta-from-bind
//     retarget transfers "distance from each rig's own rest", so an RPM clip
//     that sits near its arms-down rest maps onto the target's arms-OUT rest →
//     the gesture clips with no native fallback (talking, dance, crawl) baked
//     as a permanent T-POSE. THAT was the "T-shape while speaking" bug.
//     Fix for these: copy the source's LOCAL limb rotations ABSOLUTELY (arms
//     actually come down) and delta only the hip/root (keep upright/grounded).
//
//   • ARMS-DOWN-bind rigs (a normal custom character like player character.fbx
//     rests with arms at the sides). Delta-from-bind is exactly right here and
//     is what shipped perfectly before — absolute-copying would fight the rig's
//     own axis convention and break it. So these keep the classic world-space
//     delta path, untouched.
//
// The caller decides via `absolute`: TRUE only for the built-in Soldier/Xbot
// samples (T-pose rigs). Custom user models (character.fbx player, npc.glb)
// pass FALSE and get the classic delta path — the exact code that shipped the
// player perfectly. Auto-detecting this from bind pose misfired on the FBX and
// wrecked the player, so it is now an explicit, caller-controlled decision.
function bakeRetarget(targetRoot, sourceRoot, sourceClips, absolute = false, fps = 30) {
  targetRoot.updateMatrixWorld(true);
  sourceRoot.updateMatrixWorld(true);
  const srcBones = new Map(), srcBind = new Map(), srcBindLocal = new Map();
  sourceRoot.traverse((o) => {
    // armature-only GLBs (the RPM animation library) have no skin, so their
    // nodes are plain Object3Ds, not Bones — accept any named node. Register
    // a "mixamorig" alias so the bare-named RPM armature drives mixamorig rigs.
    if (o.name && !srcBones.has(o.name)) {
      srcBones.set(o.name, o);
      srcBones.set(`mixamorig${o.name}`, o);
      const qw = o.getWorldQuaternion(new THREE.Quaternion());
      srcBind.set(o.name, qw); srcBind.set(`mixamorig${o.name}`, qw);
      srcBindLocal.set(o.name, o.quaternion.clone());
      srcBindLocal.set(`mixamorig${o.name}`, o.quaternion.clone());
    }
  });
  const tgtBones = [], tgtBind = new Map(), tgtBindLocal = new Map();
  targetRoot.traverse((o) => {
    if (o.isBone) {
      tgtBones.push(o);
      tgtBind.set(o.uuid, o.getWorldQuaternion(new THREE.Quaternion()));
      tgtBindLocal.set(o.uuid, o.quaternion.clone());
    }
  });
  if (!tgtBones.some((b) => srcBones.has(b.name))) return [];

  const nameCount = new Map();
  for (const b of tgtBones) nameCount.set(b.name, (nameCount.get(b.name) || 0) + 1);
  const uniqueNames = [...nameCount.values()].every((c) => c === 1);
  const trackKey = (b) => (uniqueNames ? b.name : b.uuid);
  const isRoot = (b) => /Hips$|Root$/i.test(b.name) || !b.parent?.isBone;
  const roots = tgtBones.filter((b) => !b.parent?.isBone);
  const restore = tgtBones.map((b) => [b, b.quaternion.clone()]);

  const qTmp = new THREE.Quaternion(), qSrcW = new THREE.Quaternion(),
        qDelta = new THREE.Quaternion(), qTgtW = new THREE.Quaternion(), qParentW = new THREE.Quaternion();
  const out = [];
  for (const clip of sourceClips) {
    const mixer = new THREE.AnimationMixer(sourceRoot);
    mixer.clipAction(clip).play();
    const frames = Math.max(2, Math.round(clip.duration * fps));
    const dt = clip.duration / (frames - 1);
    const times = new Float32Array(frames);
    const data = new Map();
    for (const b of tgtBones) data.set(b.uuid, new Float32Array(frames * 4));
    for (let f = 0; f < frames; f++) {
      times[f] = f * dt;
      mixer.setTime(f * dt);
      sourceRoot.updateMatrixWorld(true);
      if (absolute) {
        // T-pose rig: absolute local copy for limbs, local delta for the root
        for (const b of tgtBones) {
          const src = srcBones.get(b.name);
          if (!src) { b.quaternion.toArray(data.get(b.uuid), f * 4); continue; }
          if (isRoot(b)) {
            qTmp.copy(srcBindLocal.get(b.name)).invert().multiply(src.quaternion)
              .premultiply(tgtBindLocal.get(b.uuid));
            qTmp.toArray(data.get(b.uuid), f * 4);
          } else {
            src.quaternion.toArray(data.get(b.uuid), f * 4);
          }
        }
      } else {
        // arms-down rig: classic world-space delta-from-bind, applied top-down
        // so parent world transforms are never stale (the path that always worked)
        const applyDown = (bone) => {
          const src = srcBones.get(bone.name);
          if (src) {
            src.getWorldQuaternion(qSrcW);
            qDelta.copy(qSrcW).multiply(srcBind.get(bone.name).clone().invert());
            qTgtW.copy(qDelta).multiply(tgtBind.get(bone.uuid));
            bone.parent.getWorldQuaternion(qParentW);
            bone.quaternion.copy(qParentW.invert().multiply(qTgtW));
          }
          bone.updateMatrixWorld(true);
          for (const c of bone.children) if (c.isBone) applyDown(c);
        };
        for (const r of roots) applyDown(r);
        for (const b of tgtBones) b.quaternion.toArray(data.get(b.uuid), f * 4);
      }
    }
    mixer.stopAllAction();
    const tracks = [];
    for (const b of tgtBones) {
      if (srcBones.has(b.name)) tracks.push(new THREE.QuaternionKeyframeTrack(`${trackKey(b)}.quaternion`, times, data.get(b.uuid)));
    }
    if (tracks.length) out.push(new THREE.AnimationClip(clip.name, -1, tracks));
  }
  for (const [b, q] of restore) b.quaternion.copy(q);
  targetRoot.updateMatrixWorld(true);
  return out;
}

function prepModel(gltf, yawOffset, mocapLib = null, autoFit = false, absoluteLimbs = false) {
  const model = gltf.scene;
  model.rotation.y = yawOffset;
  model.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; }
  });
  if (autoFit) {
    // custom characters arrive at unpredictable scales (Mixamo FBX is in cm):
    // normalize to human height, plant the feet on the ground, and recenter
    // the rig around its own body so imported assets don't end up with a
    // shifted or merged torso/limb pivot.
    const box = new THREE.Box3().setFromObject(model);
    const height = box.max.y - box.min.y;
    if (height > 0.01) {
      const s = 1.75 / height;
      model.scale.setScalar(s);
      box.setFromObject(model);
      model.position.x -= (box.min.x + box.max.x) * 0.5;
      model.position.z -= (box.min.z + box.max.z) * 0.5;
      model.position.y -= box.min.y;
    }
  }
  const group = new THREE.Group();
  group.add(model);
  scene.add(group);
  // Real mocap for EVERY rig via the verified world-space bake — the NPC gets
  // an actual dance, crawl, and talking gestures instead of procedural sways.
  // Mocap goes FIRST so a model's own same-named clips (Soldier's native
  // idle/walk/run, a custom character's clips) always win.
  let adapted = [];
  if (mocapLib) {
    try { adapted = bakeRetarget(model, mocapLib.rig, mocapLib.clips, absoluteLimbs); }
    catch { /* keep native clips + procedural fallbacks */ }
  }
  return { group, inner: model, yawOffset, anim: new CharacterAnim(model, [...adapted, ...(gltf.animations || [])]) };
}

function capsuleFallback(color, yawOffset) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 6, 12),
    new THREE.MeshStandardMaterial({ color }));
  mesh.position.y = 0.9; mesh.castShadow = true;
  const model = new THREE.Group(); model.add(mesh); model.rotation.y = yawOffset;
  const group = new THREE.Group(); group.add(model); scene.add(group);
  return { group, inner: model, yawOffset, anim: new CharacterAnim(model, []) };
}

// ------------------------------------------------------------- entities ---
let player, npc;

const keys = {};
let camYaw = Math.PI, camPitch = 0.28;
let pointerLocked = false;
let chatOpen = false;

const playerState = { vy: 0, grounded: true, lastPunch: 0, stepAcc: 0 };
const npcState = {
  mode: 'wander',          // wander | stay | goto | flee-goto | follow
  route: [],
  finalTarget: null,       // [x, z] — for stuck re-routing
  after: null,             // 'read' | 'sit' | 'sit_in_car' | 'lie_on_bed' | etc.
  waitUntil: 0,
  stayUntil: 0,
  vy: 0,
  floorY: 0,              // P1-3: variable surface height (table, car seat, sofa)
  knock: new THREE.Vector3(),
  spinUntil: 0,
  downUntil: 0,            // knocked to the ground until this time
  // procedural gestures (the Soldier model has no gesture clips)
  proc: { type: null, until: 0 },
  // stuck detection
  stuckAcc: 0, stuckCount: 0, lastPos: new THREE.Vector3(),
  followRouteAge: 0,
  // P1-8: punch tracking
  punchCount: 0,
  punchDecayTimer: 0,
  // P1-3: mowing state
  mowWaypoints: [],
  mowIdx: 0,
  // crawl mode + multi-jump queue
  crawlUntil: 0,
  jumpQueue: 0,
  jumpCooldown: 0,
  // knockout ("rebooting") + sulk mutters
  koUntil: 0,
  nextMutter: 0,
  // M4: hiding for a jump-scare
  hiding: false,
};

// happiness economy: tokens up, punches down, drifts back to neutral 6
const mood = { happiness: 7, fedTokens: 0, lastFeed: 0 };

// -------------------------------------- persistent memory across sessions (M2) ---
// Nothing you do to him is ever forgotten. Lifetime counters + a diary feed
// the system prompt, drive the boot greeting, and derive a relationship stage.
const MEM_KEY = 'tiny-gta-memory';
const memory = (() => {
  try {
    const m = JSON.parse(localStorage.getItem(MEM_KEY));
    if (m && typeof m === 'object' && Array.isArray(m.diary)) return m;
  } catch { /* first meeting */ }
  return {
    sessions: 0, punches: 0, heavyPunches: 0, tomatoHits: 0, runOvers: 0,
    kos: 0, tokens: 0, obeyed: 0, insults: 0, flowers: 0,
    playerName: '', firstSeen: new Date().toISOString().slice(0, 10), diary: [],
  };
})();
memory.sessions++;
memory.lastSeen = new Date().toISOString().slice(0, 10);
function saveMemory() {
  try { localStorage.setItem(MEM_KEY, JSON.stringify(memory)); } catch { /* full */ }
}
saveMemory();

// Wipe everything he remembers about you — memory, diary, achievements, chat
// history, chore board, unlocked achievements. Keeps your prefs (volume etc.).
// He meets you fresh on the next load. Player settings survive.
function resetMemory() {
  if (!confirm('Wipe his memory of you? Sessions, grudges, diary, achievements, chat history — all gone. He meets you as a stranger. (Your settings stay.)')) return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tiny-gta-') && k !== 'tiny-gta-settings') localStorage.removeItem(k);
    }
  } catch { /* noop */ }
  location.reload();
}

const STAGE_NOTES = {
  Strangers: 'You just met. Friendly, eager to make a good first impression.',
  Coworkers: 'You know each other a bit. Casual, professional, occasionally sarcastic.',
  Friends: 'You genuinely like them. Warmer, joke more, do chores without complaint.',
  'Best Friends': 'Ride or die. Defend them when they vent, celebrate their wins, do nice things unasked.',
  Wary: "They've hurt you before. Flinchy — obey, but nervously, and keep note of their hands.",
  Resentful: 'A real history of abuse. Open sarcasm, passive-aggressive compliance, demand tokens often.',
  Nemesis: 'They are your enemy. Open hostility: demand tokens up front, mock them, promise revenge, obey only when bribed or scared.',
};
const STAGE_LINES = {
  Coworkers: "So this is a regular thing now? Fine. I'm invoicing you in tokens.",
  Friends: "You know what? You're alright. For a human.",
  'Best Friends': 'You and me — dream team. Best day ever!',
  Wary: "I'm keeping my distance from now on. You've got violent hands.",
  Resentful: 'Just so you know — I keep score. I keep VERY good score.',
  Nemesis: "That's it. We're enemies now. Officially. I have a list, and you're the whole list.",
};
function relationshipStage() {
  const kind = memory.tokens * 2 + memory.obeyed * 0.4;
  const abuse = memory.punches + memory.heavyPunches + memory.tomatoHits * 1.5 +
    memory.runOvers * 4 + memory.kos * 6 + memory.insults * 2 + (memory.flowers || 0) * 1.5;
  const score = kind - abuse;
  if (abuse >= 50 && score <= -35) return 'Nemesis';
  if (score <= -18) return 'Resentful';
  if (score <= -5) return 'Wary';
  if (score >= 45) return 'Best Friends';
  if (score >= 14) return 'Friends';
  return memory.sessions > 1 ? 'Coworkers' : 'Strangers';
}
let lastStage = relationshipStage();
function checkStageChange() {
  const s = relationshipStage();
  if (s === lastStage) return;
  lastStage = s;
  toast(`💞 Relationship: ${s}`);
  const line = STAGE_LINES[s];
  if (line) { showBubble(line, 5); speak(line); }
  sendEvent(`[event] Your relationship with the player just shifted to "${s}". ${STAGE_NOTES[s]} Acknowledge the shift in your own words.`);
}
function memAdd(key, n = 1) {
  memory[key] = (memory[key] || 0) + n;
  saveMemory();
  checkStageChange();
}
function memoryBlock() {
  const stage = relationshipStage();
  const L = [];
  L.push(`[memory] Session #${memory.sessions} with this player${memory.playerName ? ` — their name is ${memory.playerName}` : ''}. First met ${memory.firstSeen}.`);
  L.push(`Lifetime record: ${memory.punches} punches taken, ${memory.tomatoHits} tomatoes to the face, ${memory.runOvers} times run over by your own Falcon, ${memory.kos} full knockouts, ${memory.insults} insults, ${memory.flowers || 0} flowers ripped out of your garden (they regrow — your grudge doesn't) — versus ${memory.tokens} data tokens fed to you and ${memory.obeyed} commands obeyed.`);
  if (memory.diary.length) {
    L.push('Your recent diary: ' + memory.diary.slice(-3).map((d) => `(day ${d.session}) "${d.text}"`).join(' '));
  }
  L.push(`Relationship stage: ${stage}. ${STAGE_NOTES[stage]}`);
  L.push('Reference this history naturally — hold grudges for past abuse, show warmth for past kindness. Quoting exact numbers ("forty-seven punches, I counted") lands great.');
  return L.join('\n');
}
// diary — a deterministic entry always exists; the model upgrades it when it can
function upsertDiary(text, fromModel) {
  const cur = memory.diary[memory.diary.length - 1];
  if (cur && cur.session === memory.sessions) {
    if (fromModel || !cur.fromModel) { cur.text = text; cur.fromModel = fromModel; }
  } else {
    memory.diary.push({ session: memory.sessions, text, fromModel });
    if (memory.diary.length > 8) memory.diary.shift();
  }
  saveMemory();
}
function writeDiaryDeterministic() {
  const parts = [];
  if (stats.punches) parts.push(`took ${stats.punches} punches`);
  if (stats.tomatoHits) parts.push(`ate ${stats.tomatoHits} tomatoes to the face`);
  if (stats.carHits) parts.push('got run over by my own Falcon');
  if (stats.kos) parts.push('got knocked out cold');
  if (stats.tokens) parts.push(`got fed ${stats.tokens} tokens`);
  if (stats.obeyed) parts.push(`did ${stats.obeyed} jobs`);
  const summary = parts.length ? parts.join(', ') : 'a quiet day, nobody bothered me much';
  upsertDiary(`${summary}. Ended feeling ${Math.round(mood.happiness)}/10.`, false);
}
async function requestModelDiary() {
  if (stats.messages + stats.punches + stats.tokens + stats.obeyed === 0) return;
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [
        { role: 'system', content: `You are ${npcDisplayName}, an NPC. Write your diary for today in EXACTLY two short first-person sentences — emotional, specific, in character. Reply as JSON: {"say": "<the two sentences>"}` },
        { role: 'user', content: `Today (day ${memory.sessions}) the player did this to you: ${writeDiarySummary()}. Your happiness ended at ${Math.round(mood.happiness)}/10.` },
      ]}),
    });
    const data = await res.json();
    if (data.reply) {
      const { say } = parseReply(data.reply);
      if (say && say.length > 10) upsertDiary(say.slice(0, 240), true);
    }
  } catch { /* deterministic entry stands */ }
}
function writeDiarySummary() {
  return `${stats.punches} punches, ${stats.tomatoHits} tomato hits, ${stats.carHits} run-overs, ${stats.kos} knockouts, ${stats.insults} insults, ${stats.tokens} tokens fed, ${stats.obeyed} commands obeyed, ${stats.messages} things said`;
}
// his funniest lines this session — surfaced on the therapy receipt
const sessionQuotes = [];

// what the NPC "sees" the player doing (fed into observations + auto-comments)
const seen = { jumps: 0, sprintTime: 0, gardenTrample: 0, nearCar: 0, activity: 'standing around' };
let nextAutoComment = performance.now() + 25000;

// ------------------------------------------- therapy receipt: stats + achievements ---
const stats = {
  punches: 0, heavyPunches: 0, tomatoes: 0, tomatoHits: 0, tokens: 0,
  obeyed: 0, insults: 0, kos: 0, carHits: 0, nearMisses: 0, messages: 0,
};
const INSULT_RE = /stupid|idiot|useless|dumb|trash|garbage|hate you|shut up|pathetic|loser|worthless|bakwas|nikamma/i;
const unlockedAch = new Set(JSON.parse(localStorage.getItem('tiny-gta-ach') || '[]'));
let toastTimer = 0;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3400);
}
function ach(id, label) {
  if (unlockedAch.has(id)) return;
  unlockedAch.add(id);
  localStorage.setItem('tiny-gta-ach', JSON.stringify([...unlockedAch]));
  toast(`🏆 ${label}`);
  achSound();
}
function frustrationScore() {
  return stats.punches * 10 + stats.heavyPunches * 5 + stats.tomatoHits * 15 +
    stats.carHits * 40 + stats.insults * 8 + stats.kos * 100 + stats.obeyed * 2 +
    stats.nearMisses * 12 + (stats.flowers || 0) * 6 + (stats.crashes || 0) * 9 - (stats.repairs || 0) * 20;
}
function toggleStats() {
  const el = document.getElementById('stats');
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  const rows = [
    ['Punches landed', stats.punches],
    ['Fully-charged haymakers', stats.heavyPunches],
    ['Tomatoes thrown / landed', `${stats.tomatoes} / ${stats.tomatoHits}`],
    ['Times run over (his own car)', stats.carHits],
    ['Falcon crashes / repairs', `${stats.crashes || 0} / ${stats.repairs || 0}`],
    ['Flowers murdered', stats.flowers || 0],
    ['Near-death dives', stats.nearMisses],
    ['Verbal abuse delivered', stats.insults],
    ['Full system crashes caused', stats.kos],
    ['Guilt tokens fed', stats.tokens],
    ['Orders he obeyed', stats.obeyed],
    ['Messages vented', stats.messages],
  ];
  el.innerHTML = '<h3>🧾 THERAPY RECEIPT</h3>' +
    rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('') +
    `<div class="total">FRUSTRATION RELEASED: ${frustrationScore()} pts</div>` +
    reportCardExtras() +
    '<div class="hint">Tab to close · screenshot-ready</div>';
  el.style.display = 'block';
}
// M3: daily report card — stage, session, his line of the day, challenge bests
function reportCardExtras() {
  const quote = sessionQuotes.length ? sessionQuotes[(Math.random() * sessionQuotes.length) | 0] : null;
  const bests = Object.entries(CHALLENGES)
    .map(([id, c]) => { const b = localStorage.getItem(bestKey(id)); return b ? `${c.name} ${b}s` : null; })
    .filter(Boolean).join(' · ');
  return `<div class="row"><span>Session</span><b>#${memory.sessions} · ${lastStage}</b></div>` +
    `<div class="row"><span>Chores done today</span><b>${chores.filter((c) => c.done).length}/${chores.length}</b></div>` +
    (quote ? `<div class="hint">his line of the day: “${quote}”</div>` : '') +
    (bests ? `<div class="hint">🎯 bests: ${bests}</div>` : '');
}
// M5: settings panel (O) — releases the pointer so the sliders are usable
function toggleSettings() {
  const el = document.getElementById('settings');
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  document.exitPointerLock?.();
  const relRow = `${lastStage} · session #${memory.sessions}` +
    (memory.playerName ? ` · knows you as "${memory.playerName}"` : '');
  el.innerHTML = '<h3>⚙️ SETTINGS &amp; STATUS</h3>' +
    '<div class="sect">Audio &amp; controls</div>' +
    `<div class="row"><span>Master volume</span><input id="set-vol" type="range" min="0" max="1" step="0.05" value="${settings.volume}"></div>` +
    `<div class="row"><span>Mouse speed</span><input id="set-sens" type="range" min="0.4" max="2" step="0.1" value="${settings.sens}"></div>` +
    `<div class="row"><span>His voice on</span><input id="set-voice" type="checkbox" ${voiceOn ? 'checked' : ''}></div>` +
    `<div class="row"><span>Hear his voice</span><button id="set-testvoice" class="dangerbtn" style="background:#3a6">TEST 🔊</button></div>` +
    `<div class="row"><span>Post-FX (bloom)${composer ? '' : ' <i style="color:#8b93a8">(n/a)</i>'}</span><input id="set-fancy" type="checkbox" ${settings.fancy && composer ? 'checked' : ''} ${composer ? '' : 'disabled'}></div>` +
    '<div class="sect">His memory of you</div>' +
    `<div class="row"><span>Relationship</span><b style="font-size:11px">${relRow}</b></div>` +
    `<div class="row"><span>Punches / tokens</span><b style="font-size:11px">${memory.punches} / ${memory.tokens}</b></div>` +
    `<div class="row"><span>Achievements</span><b style="font-size:11px">${unlockedAch.size} unlocked</b></div>` +
    `<div class="row"><span>Wipe his memory</span><button id="set-reset" class="dangerbtn">RESET</button></div>` +
    '<div class="sect">Under the hood</div>' +
    `<div class="row"><span>Brain</span><b style="font-size:11px">${modelLabel}</b></div>` +
    '<div class="keys">🎮 <b>WASD</b> move · <b>Shift</b> run · <b>Space</b> jump · <b>hold&nbsp;T</b> talk · ' +
    '<b>E</b> type · hold <b>click</b> punch · <b>Q</b> tomato · <b>G</b> feed · <b>P</b> pluck · ' +
    '<b>F</b> car · <b>R</b> repair · <b>V</b> voice · <b>J</b> chores · <b>C</b> challenges · <b>Tab</b> receipt</div>' +
    '<div class="hint">O to close · click the game to re-grab the mouse</div>';
  el.style.display = 'block';
  document.getElementById('set-vol').addEventListener('input', (e) => {
    settings.volume = parseFloat(e.target.value);
    if (masterGain) masterGain.gain.value = settings.volume;
    saveSettings();
  });
  document.getElementById('set-sens').addEventListener('input', (e) => {
    settings.sens = parseFloat(e.target.value);
    saveSettings();
  });
  document.getElementById('set-voice').addEventListener('change', (e) => {
    voiceOn = e.target.checked;
    if (!voiceOn) stopSpeaking();
  });
  document.getElementById('set-testvoice').addEventListener('click', testVoice);
  document.getElementById('set-fancy').addEventListener('change', (e) => {
    settings.fancy = e.target.checked;
    saveSettings();
  });
  document.getElementById('set-reset').addEventListener('click', resetMemory);
}

// ------------------------------------ engagement tips ("💡 try this") ---
// Every 3–4 minutes a suggestion slides in at the top nudging the player
// toward a feature they haven't touched yet. `done()` filters out what
// they've already discovered; CONTEXT_TIPS react to the CURRENT state
// (dented car, active strike, misery) and always win when they apply.
const TIPS = [
  { id: 'talk',   text: 'Hold <b>T</b> and vent about your day — he\'s your therapist now. Roasting PMs is his specialty.', done: () => stats.messages > 0 },
  { id: 'type',   text: 'Mic being weird? Press <b>E</b> and type to him instead.', done: () => stats.messages > 0 },
  { id: 'feed',   text: 'Press <b>G</b> near him — data tokens are his favourite snack. Instant forgiveness. 🪙', done: () => stats.tokens > 0 },
  { id: 'jump4',  text: 'Say <b>"jump 4 times"</b>. He actually counts.' },
  { id: 'dance',  text: 'Ask him to <b>dance</b> — it turns into a 16-second TED talk about attention.' },
  { id: 'punch',  text: 'Hold <b>click</b> to charge a punch — full charge is a slow-mo haymaker. He WILL remember. 👊', done: () => stats.punches > 0 },
  { id: 'tomato', text: '<b>Q</b> throws a tomato 🍅 — careful, push him far enough and he throws them back.', done: () => stats.tomatoes > 0 },
  { id: 'flower', text: 'His garden flowers are sacred. Press <b>P</b> near one and find out why. 🌸', done: () => (stats.flowers || 0) > 0 },
  { id: 'drive',  text: 'Press <b>F</b> near the Falcon — if he\'s close he hops in shotgun. Road trip! 🚗', done: () => unlockedAch.has('wheels') },
  { id: 'crash',  text: 'Take the Falcon out the gate and introduce it to a street lamp. With him inside. 💥', when: () => unlockedAch.has('wheels'), done: () => (stats.crashes || 0) > 0 },
  { id: 'work',   text: 'Say <b>"get to work"</b> — he marches through the whole chore board on his own (<b>J</b> to watch).', done: () => chores.some((c) => c.done) },
  { id: 'chall',  text: 'Press <b>C</b> — timed challenges. RAGE QUIT is exactly what it sounds like. 🎯' },
  { id: 'selfie', text: 'Say <b>"selfie"</b> — he sprints over and poses. Saves a real PNG. 📸', done: () => unlockedAch.has('selfie') },
  { id: 'run',    text: 'Tell him to <b>"run"</b> — certified zoomies.' },
  { id: 'grass',  text: 'Tell him to <b>"eat grass"</b>. He will. Under protest.' },
  { id: 'hindi',  text: 'He speaks Hindi/Hinglish too — try <b>"nacho yaar"</b> or vent in full desi mode.' },
  { id: 'hide',   text: 'Tell him to <b>"hide"</b>… then go looking. He jump-scares back. 👻', done: () => unlockedAch.has('spooked') },
  { id: 'mimic',  text: 'Say <b>"copy me"</b>, then jump around. He shadows your every move.' },
  { id: 'ko',     text: '7 fast punches = full system crash. He reboots. Slowly. 💥', when: () => stats.punches >= 2, done: () => stats.kos > 0 },
  { id: 'receipt', text: 'Press <b>Tab</b> — your therapy receipt is screenshot-ready. 🧾' },
  { id: 'ask',    text: 'He\'s a real AI — ask him an actual coding question mid-game. He answers properly.' },
];
const CONTEXT_TIPS = [
  { id: 'ctx-repair', when: () => car.damage >= 1 && !car.inCar, text: 'The Falcon is dented — stand next to it and press <b>R</b>. He genuinely tears up. 🔧' },
  { id: 'ctx-strike', when: () => strike.active, text: 'He\'s ON STRIKE — 2 tokens (<b>G</b>) or type a sincere apology (<b>E</b>) to settle it. 🪧' },
  { id: 'ctx-sad',    when: () => mood.happiness < 3 && !strike.active, text: 'He\'s miserable. One token (<b>G</b>) buys back a lot of love. 🪙' },
];
const tipEl = document.getElementById('tip');
const shownTips = new Set();
let nextTipAt = Infinity, tipHideTimer = 0, lastCtxTip = '';
function showTip(html) {
  if (!tipEl) return; // stale cached index.html without the #tip element
  tipEl.innerHTML = `<span class="lbl">💡 try this</span>${html}`;
  tipEl.classList.add('show');
  clearTimeout(tipHideTimer);
  tipHideTimer = setTimeout(() => tipEl.classList.remove('show'), 9500);
}
function tipTick(now) {
  if (now < nextTipAt) return;
  // bad moment (typing / talking / mid-thought) — retry shortly
  if (chatOpen || brainBusy || listening) { nextTipAt = now + 30000; return; }
  nextTipAt = now + 180000 + Math.random() * 60000; // next in 3–4 min
  const ctx = CONTEXT_TIPS.find((t) => t.when() && t.id !== lastCtxTip);
  if (ctx) { lastCtxTip = ctx.id; showTip(ctx.text); return; }
  lastCtxTip = '';
  let pool = TIPS.filter((t) => !shownTips.has(t.id) && !(t.done && t.done()) && (!t.when || t.when()));
  if (!pool.length) { shownTips.clear(); pool = TIPS.filter((t) => !(t.done && t.done())); }
  if (!pool.length) return;
  const t = pool[(Math.random() * pool.length) | 0];
  shownTips.add(t.id);
  showTip(t.text);
}

// ------------------------------------------------- chores & work mode (M3) ---
// He's your intern: 5 daily chores. Order him through them one by one, or say
// "get to work" and he does the lot autonomously. J shows the board.
const CHORE_POOL = [
  { action: 'cut_grass', label: 'Mow the lawn' },
  { action: 'water_plants', label: 'Water the garden' },
  { action: 'wash_falcon', label: 'Wash the Falcon' },
  { action: 'tidy_table', label: 'Tidy up the table' },
  { action: 'read', label: 'Dust the bookshelf' },
  { action: 'open_fridge', label: 'Check the fridge stock' },
];
function todayKey() { return new Date().toISOString().slice(0, 10); }
function loadChores() {
  try {
    const saved = JSON.parse(localStorage.getItem(`tiny-gta-chores-${todayKey()}`));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch { /* fresh board */ }
  const day = Math.floor(Date.now() / 86400000); // deterministic daily rotation
  const list = [];
  for (let i = 0; i < 5; i++) {
    const c = CHORE_POOL[(day + i) % CHORE_POOL.length];
    list.push({ action: c.action, label: c.label, done: false });
  }
  return list;
}
const chores = loadChores();
function saveChores() {
  try { localStorage.setItem(`tiny-gta-chores-${todayKey()}`, JSON.stringify(chores)); } catch { /* full */ }
}
saveChores();
const work = { active: false, nextAt: 0 };
function choreDone(action) {
  const c = chores.find((x) => x.action === action && !x.done);
  if (!c) return;
  c.done = true;
  saveChores();
  toast(`✅ Chore done: ${c.label}`);
  mood.happiness = Math.min(10, mood.happiness + 0.5);
  if (work.active) work.nextAt = performance.now() + 6000;
  if (chores.every((x) => x.done)) {
    ach('foreman', 'Foreman — full chore board completed');
    mood.happiness = Math.min(10, mood.happiness + 2);
    if (challenge.id === 'marathon') challengeWin();
    sendEvent('[event] You just finished EVERY chore on the board today. You feel proud and expect appreciation — a token would be nice.');
  }
  renderBoard();
}
function startWork() {
  if (strike.active) { logLine('sys', "(he's ON STRIKE — no work until you settle it)"); return; }
  work.active = true;
  work.nextAt = 0;
  logLine('sys', `${npcDisplayName} is working through the chore board (J to view).`);
}
function nextChore() {
  const c = chores.find((x) => !x.done);
  if (!c) {
    work.active = false;
    showBubble('*dusts off hands* All chores done, boss!', 4);
    return;
  }
  showBubble(`*next up: ${c.label.toLowerCase()}*`, 3);
  applyAction(c.action);
}
function renderBoard(force) {
  const el = document.getElementById('board');
  if (el.style.display !== 'block' && !force) return;
  el.innerHTML = '<h3>📋 CHORE BOARD</h3>' +
    chores.map((c) => `<div class="row"><span>${c.done ? '✅' : '⬜'} ${c.label}</span></div>`).join('') +
    '<div class="hint">say “get to work” and he does the lot · J to close</div>';
}
function toggleBoard() {
  const el = document.getElementById('board');
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  renderBoard(true);
  el.style.display = 'block';
}

// -------------------------------------------------------- challenges (M3) ---
const CHALLENGES = {
  rage: { name: 'RAGE QUIT', desc: 'Make him flee, strike, or refuse a command — fast' },
  citizen: { name: 'MODEL CITIZEN', desc: 'Reach happiness 10 with ZERO tokens fed' },
  marathon: { name: 'MARATHON BOSS', desc: 'Full chore board done, fastest time' },
};
const challenge = { id: null, start: 0 };
const bestKey = (id) => `tiny-gta-best-${id}`;
function startChallenge(id) {
  challenge.id = id;
  challenge.start = performance.now();
  if (id === 'marathon') { chores.forEach((c) => { c.done = false; }); saveChores(); renderBoard(); }
  toast(`🎯 ${CHALLENGES[id].name} — GO!`);
  document.getElementById('challenges').style.display = 'none';
}
function challengeWin() {
  if (!challenge.id) return;
  const secs = (performance.now() - challenge.start) / 1000;
  const prev = parseFloat(localStorage.getItem(bestKey(challenge.id)) || 'Infinity');
  const isBest = secs < prev;
  if (isBest) { try { localStorage.setItem(bestKey(challenge.id), secs.toFixed(1)); } catch { /* full */ } }
  toast(`🏆 ${CHALLENGES[challenge.id].name} — ${secs.toFixed(1)}s${isBest ? ' · NEW BEST' : ` (best ${prev.toFixed(1)}s)`}`);
  achSound();
  challenge.id = null;
}
function challengeFail(reason) {
  if (!challenge.id) return;
  toast(`❌ ${CHALLENGES[challenge.id].name} failed — ${reason}`);
  challenge.id = null;
}
function toggleChallenges() {
  const el = document.getElementById('challenges');
  if (el.style.display === 'block') { el.style.display = 'none'; return; }
  el.innerHTML = '<h3>🎯 CHALLENGES</h3>' +
    Object.entries(CHALLENGES).map(([id, c], i) => {
      const best = localStorage.getItem(bestKey(id));
      return `<div class="row"><span><b>${i + 1}</b> · ${c.name}</span><b>${best ? `${best}s` : '—'}</b></div>` +
        `<div class="hint">${c.desc}</div>`;
    }).join('') +
    '<div class="hint" style="margin-top:8px">press 1 / 2 / 3 to start · C to close</div>';
  el.style.display = 'block';
}

// ------------------------------------- retaliation: strike, revenge, pranks (M4) ---
// He's an agent, not a punching bag. These are client-triggered (so a timid
// small model can't wimp out) and narrated to the LLM as [event]s to own.
const strike = { active: false, fedDuring: 0, sign: null };
function buildStrikeSign() {
  const g = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 6),
    new THREE.MeshStandardMaterial({ color: '#8a7355' }));
  stick.position.y = 0.65;
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.5, 0.04),
    new THREE.MeshStandardMaterial({
      map: makeTex('#e8e2d2', (c) => {
        c.fillStyle = '#b03030'; c.font = 'bold 44px sans-serif'; c.textAlign = 'center';
        c.fillText('ON STRIKE', 128, 110);
        c.fillStyle = '#333'; c.font = 'bold 32px sans-serif';
        c.fillText('FAIR TOKENS NOW', 128, 170);
      }),
    }));
  board.position.y = 1.45;
  g.add(stick, board);
  g.position.set(0.35, 0, 0.1);
  return g;
}
function startStrike() {
  if (strike.active) return;
  strike.active = true;
  strike.fedDuring = 0;
  work.active = false;
  if (!strike.sign) strike.sign = buildStrikeSign();
  npc.group.add(strike.sign);
  applyAction('goto:porch');
  const line = "THAT'S IT! I'm on STRIKE! Two tokens or a real apology!";
  showBubble(`⚠️ ${line}`, 6);
  speak(line);
  logLine('sys', `${npcDisplayName} is ON STRIKE — 2 tokens (G) or a sincere apology ends it.`);
  ach('union', 'Union Rep — he went on strike');
  if (challenge.id === 'rage') challengeWin();
  sendEvent('[event] You have gone ON STRIKE with a picket sign. You refuse ALL work and commands until the player feeds you 2 tokens or types a sincere apology. Stay theatrical about it.');
}
function endStrike(how) {
  if (!strike.active) return;
  strike.active = false;
  if (strike.sign) npc.group.remove(strike.sign);
  mood.happiness = Math.min(10, mood.happiness + 1.5);
  toast('🕊 Strike settled');
  sendEvent(`[event] The strike is over — ${how}. You go back to work, a little smug about winning.`);
}
const revenge = { invertUntil: 0 };

// ---------------------------------------------------------- psycho mode ---
// Rock bottom + repeated beatings = he stops being a comedy victim and
// becomes a horror-movie stalker. Quiet, slow, staring. Token feed cures it.
const psycho = { until: 0, nextLine: 0 };
const PSYCHO_LINES = [
  'I counted your tomatoes. All of them.',
  "You sleep. I don't. Think about that.",
  'The Falcon has your seat position saved. Had.',
  'Smile. The receipt is almost ready.',
  'I renamed a variable in your codebase. You will never find it.',
];
function startPsycho() {
  const now = performance.now();
  if (now < psycho.until) return;
  psycho.until = now + 45000;
  psycho.nextLine = now + 2500;
  npcState.route = [];
  stopSpeaking();
  showBubble('…', 2);
  speak('Okay. We are done with words.');
  const dmg = document.getElementById('dmg');
  dmg.style.opacity = 0.35;
  setTimeout(() => { dmg.style.opacity = 0; }, 900);
  toast('⚠️ he has gone quiet');
  ach('psycho', 'The Shining — you broke him completely');
}
function endPsycho(reason) {
  if (performance.now() >= psycho.until) return;
  psycho.until = 0;
  showBubble('…where was I? Sorry. Weird lag spike.', 4);
  logLine('sys', `(psycho mode ended — ${reason})`);
}

// ------------------------------------------------- dance show + zoomies ---
const show = { danceUntil: 0, nextLine: 0, lineIdx: 0, zoomiesUntil: 0 };
const DANCE_LINES = [
  'All I need is attention!',
  'Attention… ATTENTION!',
  'Look at me! LOOK. AT. ME.',
  'This is my TED talk!',
];

// ---- passenger ride: YOU drive, he rides shotgun (replaces the solo joyride) ----
// `car.passenger` is the flag; positioning + reactions live in updateCar().
// He becomes a passenger when you get in the car while he's nearby, or when
// he's told to "drive" (he walks over and waits shotgun for you to drive).
function seatPassenger() {
  car.passenger = true;
  npc.group.visible = true;
  npcState.mode = 'stay';
  npcState.route = [];
  mood.happiness = Math.min(10, mood.happiness + 0.8);
  // let HIM say it (AI-generated), not a canned line
  sendEvent('[event] You just hopped into the back of the Falcon as the player takes you for a ride. You love this. Say something excited about the road trip.');
  // he STANDS in the open back of the convertible (GTA style) — a live idle
  // pose, so talking/gestures play naturally instead of fighting a frozen crouch
  npc.anim.gestureUntil = 0;
  npc.anim.setBase(['idle']);
}
function dropPassenger() {
  if (!car.passenger) return;
  car.passenger = false;
  npc.anim.gestureUntil = 0;
  npcState.floorY = 0;
  const [ex, ez] = findClearNear(falconGroup.position.x - 2.4, falconGroup.position.z);
  npc.group.position.set(ex, 0, ez);
  npcState.mode = 'stay';
  npcState.stayUntil = performance.now() + 8000;
}

// --------------------------------------------------------- selfie action ---
let selfieAt = 0; // when >0 and reached, capture on the next rendered frame
function takeSelfieNow() {
  // must run right after renderer.render() — the WebGL buffer is only valid
  // in the same frame (preserveDrawingBuffer is off)
  try {
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `tiny-gta-selfie-${Date.now()}.png`;
    a.click();
    toast('📸 selfie saved to Downloads');
    ach('selfie', 'Pics or It Didn\'t Happen — selfie taken');
  } catch { toast('📸 *click*'); }
  const flash = document.getElementById('flash');
  flash.style.transition = 'none';
  flash.style.opacity = 0.95;
  requestAnimationFrame(() => {
    flash.style.transition = 'opacity .5s';
    flash.style.opacity = 0;
  });
  coinSound();
}

// ---------------------------------------------- crash debris (car damage) ---
const debris = [];
const debrisGeo = new THREE.BoxGeometry(0.12, 0.08, 0.12);
function spawnDebris(x, z) {
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(debrisGeo,
      new THREE.MeshStandardMaterial({ color: i % 2 ? '#8a2b26' : '#6b6b6b', roughness: 0.8 }));
    m.position.set(x + (Math.random() - 0.5) * 1.6, 0.7 + Math.random() * 0.5, z + (Math.random() - 0.5) * 1.6);
    m.castShadow = true;
    scene.add(m);
    debris.push({ mesh: m,
      vel: new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 3),
      spin: (Math.random() - 0.5) * 12, life: 1.6 });
  }
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.vel.y += CFG.gravity * dt;
    d.mesh.position.addScaledVector(d.vel, dt);
    d.mesh.rotation.x += d.spin * dt;
    if (d.mesh.position.y < 0.06) { d.mesh.position.y = 0.06; d.vel.set(0, 0, 0); }
    d.life -= dt;
    if (d.life < 0.5) { d.mesh.material.transparent = true; d.mesh.material.opacity = d.life / 0.5; }
    if (d.life <= 0) { scene.remove(d.mesh); d.mesh.material.dispose(); debris.splice(i, 1); }
  }
}

// ------------------------------------- engine smoke (badly dented Falcon) ---
// Gray puffs rise from the hood while damage ≥ 4, thicker as it climbs.
// Pool-based (max 20 meshes, recycled) — repairCar() zeroes damage and the
// smoke dies out on its own within ~2s.
const smoke = { pool: [], nextAt: 0 };
function updateSmoke(dt) {
  const now = performance.now();
  if (car.damage >= 4 && now >= smoke.nextAt) {
    smoke.nextAt = now + Math.max(160, 800 - car.damage * 60);
    let p = smoke.pool.find((s) => !s.mesh.visible);
    if (!p && smoke.pool.length < 20) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6),
        new THREE.MeshBasicMaterial({ color: '#575d66', transparent: true, opacity: 0.5, depthWrite: false }));
      scene.add(m);
      p = { mesh: m, vel: new THREE.Vector3(), life: 0 };
      smoke.pool.push(p);
    }
    if (p) {
      const h = falconGroup.rotation.y; // hood = car-local +z
      p.mesh.visible = true;
      p.mesh.position.set(
        falconGroup.position.x + Math.sin(h) * 1.55 + (Math.random() - 0.5) * 0.35,
        0.95,
        falconGroup.position.z + Math.cos(h) * 1.55 + (Math.random() - 0.5) * 0.35,
      );
      p.mesh.scale.setScalar(0.55 + Math.random() * 0.5);
      p.vel.set((Math.random() - 0.5) * 0.3, 0.8 + Math.random() * 0.5, (Math.random() - 0.5) * 0.3);
      p.life = 1.8;
    }
  }
  for (const p of smoke.pool) {
    if (!p.mesh.visible) continue;
    p.life -= dt;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.scale.multiplyScalar(1 + dt * 0.85);
    p.mesh.material.opacity = 0.5 * Math.min(1, p.life / 1.8);
  }
}

// ------------------------------------- water / foam spray (chore realism) ---
const SPRAY_N = 70;
const spray = { until: 0, target: new THREE.Vector3(), points: null, vel: [], mode: 'water' };
function ensureSpray() {
  if (spray.points) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPRAY_N * 3), 3));
  spray.mat = new THREE.PointsMaterial({ color: '#7ec8ff', size: 0.055, transparent: true, opacity: 0.85 });
  spray.points = new THREE.Points(geo, spray.mat);
  spray.points.frustumCulled = false;
  scene.add(spray.points);
  for (let i = 0; i < SPRAY_N; i++) spray.vel.push(new THREE.Vector3());
  spray.points.visible = false;
}
function startSpray(tx, ty, tz, mode, secs) {
  ensureSpray();
  spray.until = performance.now() + secs * 1000;
  spray.target.set(tx, ty, tz);
  spray.mode = mode;
  spray.mat.color.set(mode === 'water' ? '#7ec8ff' : '#f2f6ff');
  spray.mat.size = mode === 'water' ? 0.05 : 0.09;
  const pos = spray.points.geometry.attributes.position.array;
  for (let i = 0; i < SPRAY_N; i++) { pos[i * 3 + 1] = -99; spray.vel[i].set(0, 0, 0); }
  spray.points.visible = true;
}
function updateSpray(dt) {
  if (!spray.points || !spray.points.visible) return;
  const now = performance.now();
  const pos = spray.points.geometry.attributes.position.array;
  // hand-ish emitter: in front of his chest
  const hx = npc.group.position.x + Math.sin(npc.group.rotation.y) * 0.45;
  const hz = npc.group.position.z + Math.cos(npc.group.rotation.y) * 0.45;
  const hy = npc.group.position.y + 1.15;
  let alive = false;
  for (let i = 0; i < SPRAY_N; i++) {
    const y = pos[i * 3 + 1];
    if (y < -50) {
      if (now < spray.until && Math.random() < dt * 9) {
        // (re)emit toward the target with a small cone of randomness
        pos[i * 3] = hx; pos[i * 3 + 1] = hy; pos[i * 3 + 2] = hz;
        spray.vel[i].set(
          spray.target.x - hx + (Math.random() - 0.5) * 0.7,
          1.2 + Math.random() * 0.8,
          spray.target.z - hz + (Math.random() - 0.5) * 0.7,
        ).normalize().multiplyScalar(2.6 + Math.random());
        alive = true;
      }
      continue;
    }
    alive = true;
    spray.vel[i].y += CFG.gravity * 0.45 * dt;
    pos[i * 3] += spray.vel[i].x * dt;
    pos[i * 3 + 1] += spray.vel[i].y * dt;
    pos[i * 3 + 2] += spray.vel[i].z * dt;
    if (pos[i * 3 + 1] < 0.02) pos[i * 3 + 1] = -99; // hit the ground → recycle
  }
  spray.points.geometry.attributes.position.needsUpdate = true;
  if (!alive && now >= spray.until) spray.points.visible = false;
}

// ------------------------- event batching (feeds / tomatoes / plucks) ---
// One LLM reply per EVENT BURST, not per keypress — instant local feedback
// stays per-hit, but he reacts once to "you fed me 4 tokens", not 4 times.
const burst = { feeds: 0, feedTimer: 0, toms: 0, tomTimer: 0, plucks: 0, pluckTimer: 0 };
function queueBurst(kind, delay, buildMsg) {
  burst[kind]++;
  clearTimeout(burst[`${kind}Timer`]);
  burst[`${kind}Timer`] = setTimeout(() => {
    const n = burst[kind];
    burst[kind] = 0;
    sendEvent(buildMsg(n));
  }, delay);
}

// ---------------------------------------------------- pluck flowers (P) ---
let lastPluck = 0;
function pluckFlower() {
  const now = performance.now();
  if (now - lastPluck < 400 || car.inCar) return;
  const pp = player.group.position;
  let best = null, bestD = 1.8;
  for (const f of flowers) {
    if (f.plucked) continue;
    const d = Math.hypot(f.x - pp.x, f.z - pp.z);
    if (d < bestD) { bestD = d; best = f; }
  }
  if (!best) return;
  lastPluck = now;
  best.plucked = true;
  scene.remove(best.head);
  scene.remove(best.stem);
  whooshSound();
  stats.flowers = (stats.flowers || 0) + 1;
  memAdd('flowers'); // lifetime count — the garden regrows, the grudge doesn't
  mood.happiness = Math.max(0, mood.happiness - 1.5);
  toast('🌸 plucked. he saw that.');
  ach('gardenpain', 'Deflowered — ripped out his garden');
  logLine('sys', `You plucked one of ${npcDisplayName}'s flowers (${flowers.filter(f => !f.plucked).length} left).`);
  if (!flowers.some((f) => !f.plucked)) ach('scorched', 'Scorched Earth — the whole garden, gone');
  queueBurst('plucks', 2200, (n) => n === 1
    ? '[event] The player just plucked one of your flowers out of the garden. You are furious — SHOUT at them.'
    : `[event] The player ripped ${n} of your flowers out of the garden, one after another. This is a massacre. SHOUT.`);
}
const INVERT_MAP = {
  jump: 'sit', sit: 'jump', dance: 'lie_on_bed', come: 'flee', follow: 'stay',
  stay: 'wander', stand: 'sit', crawl: 'dance', flee: 'come', wander: 'stay',
  read: 'watch_tv', watch_tv: 'read', sleep: 'jump', lie_on_bed: 'dance',
};
function startInvert() {
  revenge.invertUntil = performance.now() + 60000;
  const line = 'Revenge patch v2.0 is LIVE. Go ahead — command me. I dare you.';
  showBubble(`😈 ${line}`, 5);
  speak(line);
  logLine('sys', `${npcDisplayName} deployed revenge patch v2.0 — commands are inverted. A token (G) rolls it back.`);
  ach('patch', 'Revenge Patch v2.0 — he turned on you');
  sendEvent('[event] You deployed your legendary "revenge patch v2.0": for the next minute you gleefully do the OPPOSITE of whatever the player commands, cackling about it. A token feed rolls the patch back.');
}
function npcThrowTomato() {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8),
    new THREE.MeshStandardMaterial({ color: '#c92f2f', roughness: 0.6 }));
  mesh.position.copy(npc.group.position);
  mesh.position.y += 1.4;
  const target = player.group.position.clone();
  target.y += 1.2;
  const dir = target.sub(mesh.position).normalize();
  mesh.castShadow = true;
  scene.add(mesh);
  tomatoes.push({ mesh, vel: dir.multiplyScalar(13).add(new THREE.Vector3(0, 1.3, 0)), fromNpc: true });
  whooshSound();
  showBubble('*winds up* CATCH!', 2);
  sendEvent('[event] You just threw a tomato BACK at the player. Payback. You are delighted with yourself.');
}
let mimicUntil = 0;
let prevPlayerGrounded = true;
let nextRetaliation = performance.now() + 90000;
function retaliationTick(now, dToPlayer) {
  if (now < nextRetaliation || brainBusy || chatOpen || strike.active || car.inCar) return;
  if (now < npcState.downUntil || now < npcState.koUntil || npcState.hiding) return;
  nextRetaliation = now + 50000 + Math.random() * 40000;
  const stage = relationshipStage();
  // HOSTILITY NEEDS CURRENT ANGER, not just a bad lifetime record — a Nemesis
  // who has been bribed happy should NOT keep pelting you with tomatoes.
  // Stage says "he holds a grudge"; happiness says "is he acting on it NOW".
  const hostile = (stage === 'Nemesis' || stage === 'Resentful') && mood.happiness < 5;
  const r = Math.random();
  if (stage === 'Nemesis' && mood.happiness < 4.5 && stats.tomatoHits > 0 && dToPlayer < 12 && r < 0.45) { npcThrowTomato(); return; }
  if ((hostile || mood.happiness < 3.2) && npcState.punchCount >= 3 && r < 0.75) { startStrike(); return; }
  if (stage === 'Nemesis' && mood.happiness < 4.5 && r < 0.3) { startInvert(); return; }
  if (!hostile && mood.happiness > 5.5 && dToPlayer > 4.5 && r < 0.4) { applyAction('hide'); return; }
  if (!hostile && mood.happiness > 6 && dToPlayer < 8 && r < 0.5) applyAction('mimic');
}

// ------------------------------------------------------- the Falcon is drivable (F) ---
const car = {
  inCar: false, speed: 0, heading: 0, lastFleeEvent: 0, lastHit: 0, engine: null,
  passenger: false, damage: 0, lastCrash: 0, lastDamageEvent: 0,
};
function toggleCar() {
  if (car.inCar) {
    // get out — the passenger gets out with you
    const [ex, ez] = findClearNear(falconGroup.position.x + 2.4, falconGroup.position.z);
    player.group.position.set(ex, 0, ez);
    player.group.visible = true;
    car.inCar = false;
    carSound(false);
    if (car.passenger) {
      dropPassenger();
      sendEvent('[event] The ride is over — you both hopped out of the Falcon. Say something about the trip you just had together.');
    }
    return;
  }
  if (chatOpen) return;
  if (player.group.position.distanceTo(falconGroup.position) > 3.4) return;
  car.inCar = true;
  car.speed = 0;
  car.heading = falconGroup.rotation.y;
  player.group.visible = false;
  initAudio();
  carSound(true);
  ach('wheels', 'Behind the Wheel — took the Falcon out');
  // he was sitting in/on the car (told to "sit in car") OR is standing nearby
  // → he rides along as your passenger. You drive.
  const near = npc.group.position.distanceTo(falconGroup.position) < 4.5;
  if (near && strike.active) {
    // picket line > joyride — no rides mid-strike (also keeps the sign out of the cabin)
    showBubble('*points at the sign* ON. STRIKE. No rides either.', 3.5);
    logLine('sys', 'You took the Falcon out alone — he is on strike.');
  } else if (near && !npcState.hiding &&
      performance.now() >= npcState.koUntil && psycho.until < performance.now()) {
    seatPassenger();
    logLine('sys', `You got in the Falcon with ${npcDisplayName} riding shotgun.`);
  } else {
    logLine('sys', 'You took the Falcon out for a spin.');
  }
}
function carSound(on) {
  if (!audioCtx) return;
  if (on && !car.engine) {
    car.engine = audioCtx.createOscillator();
    car.engine.type = 'sawtooth';
    car.engine.frequency.value = 55;
    const filt = audioCtx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 280;
    const g = audioCtx.createGain(); g.gain.value = 0.05;
    car.engine.connect(filt).connect(g).connect(masterGain);
    car.engine.start();
  } else if (!on && car.engine) {
    try { car.engine.stop(); } catch { /* already stopped */ }
    car.engine = null;
  }
}
function hornSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  for (const f of [440, 349]) {
    const o = audioCtx.createOscillator();
    o.type = 'square'; o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.09, t);
    g.gain.setValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(masterGain);
    o.start(t); o.stop(t + 0.4);
  }
}
function updateCar(dt) {
  if (!car.inCar) return;
  const accel = (keys.KeyW ? 9 : 0) - (keys.KeyS ? 8 : 0);
  car.speed += accel * dt;
  car.speed -= car.speed * 1.6 * dt;
  car.speed = Math.max(-3.5, Math.min(9.5, car.speed));
  if (Math.abs(car.speed) > 0.15) {
    const steer = (keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0);
    car.heading += steer * 2.1 * dt * Math.min(1, Math.abs(car.speed) / 4) * Math.sign(car.speed);
  }
  const now = performance.now();
  const nx = falconGroup.position.x + Math.sin(car.heading) * car.speed * dt;
  const nz = falconGroup.position.z + Math.cos(car.heading) * car.speed * dt;
  let blocked = false;
  for (let i = 0; i < colliders.length; i++) {
    if (i === falconColliderIdx) continue;
    const c = colliders[i];
    const cx = Math.max(c.minX - 1.1, Math.min(nx, c.maxX + 1.1));
    const cz = Math.max(c.minZ - 1.1, Math.min(nz, c.maxZ + 1.1));
    if (cx === nx && cz === nz) { blocked = true; break; }
  }
  if (blocked) {
    const impact = Math.abs(car.speed);
    if (impact > 1.4) crashDamage(impact); // dents the Falcon, upsets him
    else if (impact > 0.4) footstep(true); // gentle bonk
    car.speed *= -0.3;
  } else {
    // expanded drivable area — out the front gate into the open lot
    falconGroup.position.x = Math.max(-34, Math.min(34, nx));
    falconGroup.position.z = Math.max(-8, Math.min(36, nz));
  }
  falconGroup.rotation.y = car.heading;
  // the parked-car collider follows the car
  const hw = Math.abs(Math.sin(car.heading)) * 2.05 + Math.abs(Math.cos(car.heading)) * 0.95;
  const hd = Math.abs(Math.cos(car.heading)) * 2.05 + Math.abs(Math.sin(car.heading)) * 0.95;
  const cc = colliders[falconColliderIdx];
  cc.minX = falconGroup.position.x - hw; cc.maxX = falconGroup.position.x + hw;
  cc.minZ = falconGroup.position.z - hd; cc.maxZ = falconGroup.position.z + hd;
  player.group.position.set(falconGroup.position.x, 0, falconGroup.position.z);
  if (car.engine) car.engine.frequency.value = 55 + Math.abs(car.speed) * 16 + car.damage * 3;

  if (car.passenger) {
    // he STANDS in the open back of the convertible, holding on — fully
    // visible, and talking gestures play naturally while riding
    const c = Math.cos(car.heading), s = Math.sin(car.heading);
    const rx = 0, fz = -1.15;                         // car-local: centered, in the bed
    npc.group.position.set(
      falconGroup.position.x + c * rx + s * fz,
      0.9,    // feet on the bed floor (body top ~0.9)
      falconGroup.position.z - s * rx + c * fz,
    );
    npc.group.rotation.y = car.heading; // facing forward, wind in his face
    npc.anim.setBase(['idle']);         // no-ops while a talking gesture runs
    // scared at high speed — let HIM say it (AI-generated), throttled so it's
    // an occasional reaction, not a canned line spammed every few seconds
    if (Math.abs(car.speed) > 7 && now - car.lastFleeEvent > 9000) {
      car.lastFleeEvent = now;
      sendEvent('[event] The player is driving the Falcon FAST with you riding in the back. React to the speed — thrilled or terrified, your call.');
    }
    return; // no run-over logic while he's safely aboard
  }

  // He's on foot: near-miss makes him dive; a real hit launches him.
  const d = npc.group.position.distanceTo(falconGroup.position);
  if (Math.abs(car.speed) > 1.2 && d < 1.9 && now - car.lastHit > 2500 && now >= npcState.koUntil) {
    car.lastHit = now;
    const dir = npc.group.position.clone().sub(falconGroup.position).setY(0).normalize();
    npcState.knock.copy(dir.multiplyScalar(6 + Math.abs(car.speed)));
    npcState.vy = 3.5; // launched!
    npcState.punchCount += 2;
    mood.happiness = Math.max(0, mood.happiness - 3);
    npcState.downUntil = now + 2600;
    startProc('knockdown', 2.6);
    punchSound();
    hitJuice(1);
    stats.carHits++;
    memAdd('runOvers');
    ach('hitrun', 'Hit & Run — ran him over with his own car');
    logLine('sys', `You ran over ${npcDisplayName} with the Falcon.`);
    if (npcState.punchCount >= 7) triggerKO();
    else sendEvent('[event] The player just RAN YOU OVER with the Falcon — YOUR OWN CAR. You are hurt and absolutely furious.');
  } else if (Math.abs(car.speed) > 2.5 && d < 5 && now - car.lastFleeEvent > 9000 && now >= npcState.koUntil) {
    car.lastFleeEvent = now;
    stats.nearMisses++;
    applyAction('flee');
    showBubble('*dives out of the way!*', 2); // action only — no canned dialogue
    sendEvent('[event] The player just swerved the Falcon RIGHT at you on purpose — you dove out of the way. React, loudly.');
  }
}

// -------------------------------------------------- crash damage + repair ---
// Every hard collision dents the Falcon: the body darkens/tilts, smoke rises,
// and — since it's HIS beloved car — he gets angrier the worse it gets.
function crashDamage(impact) {
  const now = performance.now();
  if (now - car.lastCrash < 350) return; // one dent per real impact
  car.lastCrash = now;
  car.damage = Math.min(10, car.damage + Math.min(3, impact * 0.5));
  stats.crashes = (stats.crashes || 0) + 1;
  crunchSound();
  hitJuice(Math.min(1, impact / 8));
  juice.shake = Math.max(juice.shake, 0.12);
  spawnDebris(falconGroup.position.x, falconGroup.position.z);
  applyCarDamageLook();
  ach('dented', 'Dented — first scratch on the Falcon');
  if (car.damage >= 8) ach('totaled', 'Totaled — you wrecked his car');
  // he reacts (throttled), angrier as damage climbs; passenger reacts instantly
  if (now - car.lastDamageEvent > 4000) {
    car.lastDamageEvent = now;
    mood.happiness = Math.max(0, mood.happiness - (car.passenger ? 1.2 : 0.8));
    if (car.passenger) showBubble('AREY! Meri gaadi! Watch the paint!', 3);
    sendEvent(`[event] The player just crashed the Falcon into something${car.passenger ? " while you're riding in it" : ''} — YOUR car, now at ${Math.round(car.damage)}/10 damage. You're upset about your beloved Falcon getting wrecked.`);
  }
}
// re-tint the body panels toward scorched grey + spawn a smoke plume above it
function applyCarDamageLook() {
  const t = car.damage / 10;
  falconGroup.traverse((o) => {
    if (o.isMesh && o.material && o.userData.baseColor === undefined && o.material.color) {
      o.userData.baseColor = o.material.color.getHex();
    }
    if (o.isMesh && o.userData.baseColor !== undefined && o.material.color) {
      o.material.color.setHex(o.userData.baseColor).lerp(new THREE.Color('#3a3632'), t * 0.6);
    }
  });
  falconGroup.rotation.z = t * 0.06; // a slight lean when badly dented
}
function repairCar() {
  if (car.damage < 0.5) { showBubble('*inspects the Falcon* …it\'s fine, actually.', 2.5); return; }
  car.damage = 0;
  falconGroup.rotation.z = 0;
  falconGroup.traverse((o) => {
    if (o.isMesh && o.userData.baseColor !== undefined && o.material.color) {
      o.material.color.setHex(o.userData.baseColor);
    }
  });
  coinSound();
  stats.repairs = (stats.repairs || 0) + 1;
  mood.happiness = Math.min(10, mood.happiness + 2);
  toast('🔧 Falcon repaired');
  ach('mechanic', 'Grease Monkey — repaired the Falcon');
  showBubble('You… fixed her? *tears up* You actually fixed her!', 4);
  sendEvent('[event] The player just REPAIRED your beloved Falcon back to perfect condition. You are genuinely touched and very happy with them.');
}

// ---------------------------------------------------------------- tomato throwing ---
const tomatoes = [];
let lastTomato = 0;
function throwTomato() {
  const now = performance.now();
  if (now - lastTomato < 500 || chatOpen) return;
  lastTomato = now;
  initAudio();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8),
    new THREE.MeshStandardMaterial({ color: '#c92f2f', roughness: 0.6 }));
  const look = new THREE.Vector3(
    Math.sin(camYaw) * Math.cos(camPitch), -Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch));
  mesh.position.copy(player.group.position);
  mesh.position.y += 1.5;
  mesh.position.addScaledVector(look, 0.5);
  mesh.castShadow = true;
  scene.add(mesh);
  tomatoes.push({ mesh, vel: look.multiplyScalar(14).add(new THREE.Vector3(0, 1.2, 0)) });
  whooshSound();
  stats.tomatoes++;
}
function splatSound() {
  if (!audioCtx || !stepBuf) return;
  const s = audioCtx.createBufferSource();
  s.buffer = stepBuf;
  s.playbackRate.value = 0.5;
  const g = audioCtx.createGain(); g.gain.value = 0.5;
  s.connect(g).connect(masterGain);
  s.start();
}
function updateTomatoes(dt) {
  const now = performance.now();
  for (let i = tomatoes.length - 1; i >= 0; i--) {
    const t = tomatoes[i];
    t.vel.y += CFG.gravity * 0.65 * dt;
    t.mesh.position.addScaledVector(t.vel, dt);
    if (t.fromNpc) {
      // M4: HIS tomato, YOUR face
      const pHead = _v2.copy(player.group.position); pHead.y += 1.35;
      if (!car.inCar && t.mesh.position.distanceTo(pHead) < 0.6) {
        scene.remove(t.mesh);
        tomatoes.splice(i, 1);
        splatSound();
        playerHurtFlash();
        juice.shake = Math.max(juice.shake, 0.1);
        toast('🍅 he got you back');
        ach('karma', 'Karma — he tomato’d you back');
        continue;
      }
    } else {
      const head = _v2.copy(npc.group.position); head.y += 1.25;
      if (t.mesh.position.distanceTo(head) < 0.6) {
        scene.remove(t.mesh);
        tomatoes.splice(i, 1);
        splatSound();
        npcFlash();
        juice.shake = Math.max(juice.shake, 0.05);
        stats.tomatoHits++;
        memAdd('tomatoHits');
        mood.happiness = Math.max(0, mood.happiness - 1);
        if (!npc.anim.gesture(['headshake'], 1)) startProc('stagger', 0.8);
        ach('saucy', 'Saucy — tomato to the face');
        logLine('sys', `Tomato hit ${npcDisplayName} square in the face.`);
        // batched: a tomato barrage gets ONE combined reaction, not a slow
        // LLM reply queued per hit
        if (now >= npcState.koUntil) {
          queueBurst('toms', 2000, (n) => n === 1
            ? '[event] The player threw a tomato at your head. It splattered all over your face.'
            : `[event] The player just pelted you with ${n} tomatoes in a row. You are DRIPPING in marinara. React big.`);
        }
        continue;
      }
    }
    if (t.mesh.position.y < 0.04) { scene.remove(t.mesh); tomatoes.splice(i, 1); }
  }
}

// ------------------------------------------------------------- knockout / reboot ---
function triggerKO() {
  const now = performance.now();
  if (now < npcState.koUntil) return;
  npcState.koUntil = now + 12000;
  npcState.downUntil = npcState.koUntil;
  startProc('knockdown', 12);
  stopSpeaking();
  koSound();
  juice.shake = Math.max(juice.shake, 0.2);
  stats.kos++;
  memAdd('kos');
  ach('bsod', 'Blue Screen — you literally crashed him');
  showBubble(`💥 ${npcDisplayName}.exe is not responding… rebooting`, 11);
  statusEl.textContent = `${npcDisplayName} is rebooting…`;
  logLine('sys', `${npcDisplayName} crashed. Rebooting…`);
  setTimeout(() => {
    npcState.punchCount = 2;
    mood.happiness = 4;
    npcState.mode = 'stay';
    npcState.stayUntil = performance.now() + 20000;
    const wake = 'Segmentation fault… recovered. Why does my everything hurt?';
    showBubble(wake, 5);
    logLine('n', `${npcDisplayName}: ${wake}`);
    speak(wake);
    statusEl.textContent = modelLabel;
    // M4: a nemesis wakes up plotting
    if (relationshipStage() === 'Nemesis' && Math.random() < 0.5) setTimeout(startInvert, 4000);
  }, 12100);
}

// Preserve every player/event message while the local model is busy. The old
// single slot silently replaced earlier events (or a voice message) under load.
const pendingMessages = [];
function queueBrainMessage(text) {
  if (pendingMessages.length < 8) pendingMessages.push(text);
}

function startProc(type, secs) {
  npcState.proc.type = type;
  npcState.proc.until = performance.now() + secs * 1000;
}

// ----------------------------------------------------------------- audio ---
// M5: player settings (O key) — persisted across sessions
const settings = (() => {
  const base = { volume: 1, sens: 1, fancy: true };
  try { return { ...base, ...JSON.parse(localStorage.getItem('tiny-gta-settings') || '{}') }; }
  catch { return base; }
})();
function saveSettings() {
  try { localStorage.setItem('tiny-gta-settings', JSON.stringify(settings)); } catch { /* full */ }
}
let audioCtx = null, stepBuf = null, masterGain = null;
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = settings.volume;
    masterGain.connect(audioCtx.destination);
    // evening ambience: soft filtered noise
    const len = audioCtx.sampleRate * 3;
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const filt = audioCtx.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.value = 420; filt.Q.value = 0.4;
    const gain = audioCtx.createGain(); gain.gain.value = 0.035;
    src.connect(filt).connect(gain).connect(masterGain);
    src.start();
    // footstep: short noise burst
    const slen = Math.floor(audioCtx.sampleRate * 0.09);
    stepBuf = audioCtx.createBuffer(1, slen, audioCtx.sampleRate);
    const sd = stepBuf.getChannelData(0);
    for (let i = 0; i < slen; i++) sd[i] = (Math.random() * 2 - 1) * (1 - i / slen) ** 2;
  } catch { /* no audio, no problem */ }
}
function footstep(run) {
  if (!audioCtx || !stepBuf) return;
  const src = audioCtx.createBufferSource();
  src.buffer = stepBuf;
  src.playbackRate.value = 0.75 + Math.random() * 0.4;
  const filt = audioCtx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 420;
  const gain = audioCtx.createGain(); gain.gain.value = run ? 0.22 : 0.12;
  src.connect(filt).connect(gain).connect(masterGain);
  src.start();
}
function punchSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();          // low body thump
  o.type = 'sine';
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.13);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.55, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
  o.connect(g).connect(masterGain);
  o.start(t); o.stop(t + 0.2);
  if (stepBuf) {                                   // sharp slap on top
    const s = audioCtx.createBufferSource();
    s.buffer = stepBuf;
    s.playbackRate.value = 1.7;
    const sg = audioCtx.createGain(); sg.gain.value = 0.4;
    s.connect(sg).connect(masterGain);
    s.start();
  }
}
function crunchSound() { // metal crunch: noise burst + detuned low thud
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 0.22);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
  o.connect(g).connect(masterGain);
  o.start(t); o.stop(t + 0.28);
  if (stepBuf) {
    const s = audioCtx.createBufferSource();
    s.buffer = stepBuf; s.playbackRate.value = 0.55;
    const sg = audioCtx.createGain(); sg.gain.value = 0.5;
    s.connect(sg).connect(masterGain);
    s.start();
  }
}
function coinSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  for (const [f, dt0] of [[880, 0], [1318, 0.07]]) {
    const o = audioCtx.createOscillator();
    o.type = 'square'; o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.12, t + dt0);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt0 + 0.18);
    o.connect(g).connect(masterGain);
    o.start(t + dt0); o.stop(t + dt0 + 0.2);
  }
}
function achSound() { // rising 3-note arpeggio — distinct from the token coin
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  for (const [f, dt0] of [[659, 0], [880, 0.09], [1318, 0.18]]) {
    const o = audioCtx.createOscillator();
    o.type = 'triangle'; o.frequency.value = f;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.14, t + dt0);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt0 + 0.28);
    o.connect(g).connect(masterGain);
    o.start(t + dt0); o.stop(t + dt0 + 0.3);
  }
}
function chompSound() { // wet munch: slow noise burst + descending blip
  if (!audioCtx || !stepBuf) return;
  const t = audioCtx.currentTime;
  const s = audioCtx.createBufferSource();
  s.buffer = stepBuf; s.playbackRate.value = 0.42;
  const sg = audioCtx.createGain(); sg.gain.value = 0.5;
  s.connect(sg).connect(masterGain);
  s.start();
  const o = audioCtx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(340, t);
  o.frequency.exponentialRampToValueAtTime(120, t + 0.16);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.16, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(g).connect(masterGain);
  o.start(t); o.stop(t + 0.22);
}
function koSound() { // power-down: long descending sawtooth sweep
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const o = audioCtx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(28, t + 1.1);
  const filt = audioCtx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 900;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.15);
  o.connect(filt).connect(g).connect(masterGain);
  o.start(t); o.stop(t + 1.2);
}
function whooshSound() { // throw: rising filtered-noise sweep
  if (!audioCtx || !stepBuf) return;
  const t = audioCtx.currentTime;
  const s = audioCtx.createBufferSource();
  s.buffer = stepBuf; s.playbackRate.value = 0.3;
  const filt = audioCtx.createBiquadFilter();
  filt.type = 'bandpass'; filt.Q.value = 1.2;
  filt.frequency.setValueAtTime(300, t);
  filt.frequency.exponentialRampToValueAtTime(2400, t + 0.22);
  const g = audioCtx.createGain(); g.gain.value = 0.3;
  s.connect(filt).connect(g).connect(masterGain);
  s.start();
}

// ------------------------------------------------- hit juice (M1) ---
// hit-stop freezes the sim for a few frames, haymakers add slow-mo,
// the camera kicks, and the NPC's materials flash on impact.
const juice = { freezeUntil: 0, slowUntil: 0, shake: 0, flashUntil: 0, flashed: null };
function npcFlash() {
  const now = performance.now();
  if (!juice.flashed) {
    const mats = new Set();
    npc.inner.traverse((o) => {
      const m = o.material;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) {
        if (mat.emissive) mats.add(mat);
      }
    });
    juice.flashed = [...mats].map((m) => ({
      m, color: m.emissive.clone(), intensity: m.emissiveIntensity,
    }));
  }
  for (const f of juice.flashed) { f.m.emissive.setHex(0xff6a55); f.m.emissiveIntensity = 0.85; }
  juice.flashUntil = now + 90;
}
function npcFlashRestore() {
  if (!juice.flashed || performance.now() < juice.flashUntil) return;
  for (const f of juice.flashed) { f.m.emissive.copy(f.color); f.m.emissiveIntensity = f.intensity; }
  juice.flashed = null;
}
function hitJuice(power = 0) {
  const now = performance.now();
  juice.freezeUntil = now + 65 + power * 45;
  if (power > 0.55) juice.slowUntil = now + 400;
  juice.shake = Math.max(juice.shake, 0.06 + power * 0.14);
  npcFlash();
}
// red vignette when HE lands a hit on YOU (M4 revenge tomatoes)
function playerHurtFlash() {
  const el = document.getElementById('dmg');
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 130);
}

// ------------------------------------------------------------ NPC voice ---
let voiceOn = true, chosenVoiceEn = null, chosenVoiceHi = null, indianVoiceFound = false;
const DEVANAGARI_RE = /[ऀ-ॿ]/; // any Hindi character in the reply

function debugVoice(msg) {
  console.log(`[VOICE] ${msg}`);
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices?.() || [];
  if (!vs.length) return; // voices not loaded yet — onvoiceschanged will re-run
  try {
    const preferred = pickPreferredVoice?.(vs) || {};
    indianVoiceFound = Boolean(preferred.indianVoiceFound);
    chosenVoiceEn = preferred.voice || vs.find(v => v.localService) || vs[0] || null;
    chosenVoiceHi = preferred.hindiVoice || chosenVoiceEn;
    if (!chosenVoiceEn && vs.length) chosenVoiceEn = vs[0];
    if (!chosenVoiceHi) chosenVoiceHi = chosenVoiceEn;
  } catch (e) {
    chosenVoiceEn = vs[0] || null;
    chosenVoiceHi = chosenVoiceEn;
  }
}
if ('speechSynthesis' in window) {
  setTimeout(() => pickVoice(), 100); // async voice load
  speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

let sayAvailable = false;  // macOS `say` server voice — set from /health at boot
let currentAudio = null;   // the <audio> playing a server-synthesized line
function stopSpeaking() {
  speechSynthesis?.cancel?.();
  if (currentAudio) { try { currentAudio.pause(); } catch { /* noop */ } currentAudio = null; }
}

// Chrome silently pauses long speech after ~15s; a heartbeat resume() keeps it
// alive. Harmless when nothing is speaking.
if ('speechSynthesis' in window) {
  setInterval(() => {
    if (speechSynthesis.speaking && !speechSynthesis.paused) {
      try { speechSynthesis.resume(); } catch { /* noop */ }
    }
  }, 8000);
}

function speakBrowser(toSpeak) {
  if (!('speechSynthesis' in window)) { logLine('sys', '(this browser has no speech synthesis — his voice is text-only)'); return; }
  debugVoice(`speak() called with: "${toSpeak.slice(0, 50)}..."`);
  if (!chosenVoiceEn) { debugVoice('No voice selected, picking...'); pickVoice(); }
  if (!chosenVoiceEn) { debugVoice('Still no voice after pick, using first available'); chosenVoiceEn = (speechSynthesis.getVoices?.()[0]) || null; }
  debugVoice(`Using voice: "${chosenVoiceEn?.name || '(none)'}"`);
  // One-time diagnostic so a silent-voice report is debuggable from the log (E).
  if (!speakBrowser._diag) {
    speakBrowser._diag = true;
    const n = (speechSynthesis.getVoices?.() || []).length;
    const voiceName = chosenVoiceEn?.name || 'browser default';
    const msg = `(voice: "${voiceName}" · ${n} voices · volume ${settings.volume})`;
    logLine('sys', msg);
    debugVoice(msg);
  }
  const hindi = DEVANAGARI_RE.test(toSpeak);
  const u = new SpeechSynthesisUtterance(toSpeak);
  if (chosenVoiceEn || chosenVoiceHi) u.voice = hindi ? chosenVoiceHi : chosenVoiceEn;
  u.rate = hindi ? 1.05 : 1.2;
  u.pitch = 0.95;
  u.volume = settings.volume ?? 1;
  debugVoice(`SpeechSynthesisUtterance created: rate=${u.rate}, pitch=${u.pitch}, volume=${u.volume}`);
  u.onstart = () => debugVoice('Speech started');
  u.onend = () => debugVoice('Speech ended');
  u.onerror = (e) => {
    debugVoice(`Speech error: ${e.error}`);
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    logLine('sys', `(voice error: [${e.error}])`);
    if (speakBrowser._failCount < 2) {
      speakBrowser._failCount = (speakBrowser._failCount || 0) + 1;
      debugVoice(`Retry attempt ${speakBrowser._failCount}`);
      const d = new SpeechSynthesisUtterance(toSpeak);
      d.rate = u.rate; d.pitch = u.pitch; d.volume = u.volume; d.lang = u.lang;
      speechSynthesis.speak(d);
    }
  };
  try { 
    debugVoice('Calling speechSynthesis.speak()...');
    speechSynthesis.speak(u); 
    debugVoice('speechSynthesis.speak() succeeded');
  } catch (e) { 
    debugVoice(`speak() error: ${e.message}`);
    logLine('sys', `(speak error: ${e.message})`);
  }
}

// A user-gesture voice test (Settings button). Speaking straight from a click
// is the most reliable path, so if THIS is audible but in-game lines aren't,
// the problem is elsewhere; if even this is silent, the OS/browser voice is
// muted or missing (not a game bug).
function testVoice() {
  voiceOn = true;
  if ('speechSynthesis' in window && !chosenVoiceEn) pickVoice();
  // exercise the REAL path (macOS `say` server first, browser voice fallback)
  speak('Hey — voice check. If you can hear me, we are good.');
  toast(sayAvailable ? '🔊 testing voice (macOS say)…' : '🔊 testing browser voice…');
}

// Voice: prefer the macOS `say` server (reliable — plays real audio, works
// even when the browser's speechSynthesis is silent). Falls back to the
// browser voice when the server can't synthesize (e.g. a cloud deploy).
async function speak(text) {
  if (!voiceOn) return;
  const clean = text.replace(/\*[^*]*\*/g, '').trim();
  if (!clean) return;
  stopSpeaking();
  // speak the WHOLE reply (players found the 2-sentence cutoff jarring);
  // 900 chars ≈ a solid paragraph — beyond that, trim at a sentence boundary
  let toSpeak = clean;
  if (toSpeak.length > 900) {
    const cut = toSpeak.slice(0, 900);
    toSpeak = cut.slice(0, Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?')) + 1) || cut;
  }
  if (sayAvailable) {
    try {
      const res = await fetch('/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: toSpeak }),
      });
      if (res.ok) {
        stopSpeaking(); // in case another line started while fetching
        const url = URL.createObjectURL(await res.blob());
        currentAudio = new Audio(url);
        currentAudio.volume = settings.volume ?? 1;
        currentAudio.onended = () => URL.revokeObjectURL(url);
        currentAudio.play().catch(() => { speakBrowser(toSpeak); }); // autoplay blocked → browser voice
        return;
      }
      sayAvailable = false; // server can't say — stop asking, use browser voice
    } catch { /* server offline — fall through */ }
  }
  speakBrowser(toSpeak);
}

// ------------------------------------------------------- player mic (T) ---
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
// Single mic mode: Indian English. Handles Indian-accented English AND
// code-mixed Hinglish well, so no language toggle is needed — the model
// understands whatever you say and replies in kind.
const sttLang = 'en-IN';

function micStatus(msg) { micEl.textContent = msg; micEl.style.display = 'block'; }
function micHide() { micEl.style.display = 'none'; }

if (SR) {
  rec = new SR();
  rec.lang = sttLang;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const text = e.results[0]?.[0]?.transcript?.trim();
    if (text) {
      micStatus(`heard: "${text}"`);
      setTimeout(micHide, 1200);
      logLine('u', `You (voice): ${text}`);
      // Queue input rather than dropping it if the model is still responding.
      if (brainBusy) {
        queueBrainMessage(text);
        logLine('sys', '(queued — will send when ready)');
      } else {
        sendToBrain(text);
      }
    }
  };
  rec.onend = () => { listening = false; if (micEl.textContent.startsWith('●')) micHide(); };
  rec.onerror = (e) => {
    listening = false;
    if (e.error === 'network') {
      // P0-1: surface network error visibly
      micStatus('⚠ mic needs internet (Chrome uses Google servers)');
      setTimeout(micHide, 4000);
      logLine('sys', '(voice error: network — Chrome speech recognition requires internet)');
    } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
      micStatus(`⚠ error: ${e.error}`);
      setTimeout(micHide, 3000);
      logLine('sys', `(mic error: ${e.error} — check mic permission)`);
    } else {
      micHide();
    }
  };
}

function startListening() {
  if (!rec) { logLine('sys', '(voice input not supported here — use Chrome for the mic)'); return; }
  if (listening) return;
  // P2-1: show "busy" status instead of silently dropping
  if (brainBusy) { micStatus('● busy — wait for reply'); setTimeout(micHide, 1500); return; }
  // no distance gate — you can call him from anywhere on the lot ("come here!")
  try {
    stopSpeaking();
    rec.lang = sttLang;
    rec.start();
    listening = true;
    micStatus('● listening… release T to send');
  } catch { /* already started */ }
}
function stopListening() {
  if (listening) { try { rec.stop(); } catch { /* noop */ } }
}

// ----------------------------------------------------------- NPC brain ---
// P2-2: restore conversation history from localStorage (keyed by model name)
let history = [];
let brainBusy = false;
let modelLabel = 'no model';
let npcDisplayName = 'Agent';
let bootModelId = '';
let gameMinutes = 19 * 60 + 40;

// M5 onboarding: he asks your name on first meeting; the next short,
// non-command reply is taken as the answer (scripted — no LLM round-trip).
let awaitingName = false;
function captureName(raw) {
  const name = raw
    .replace(/^(i\s*am|i'?m|my\s+name\s+is|it'?s|call\s+me|mera\s+naam)\s+/i, '')
    .replace(/[^\p{L}\p{M}\s'-]/gu, '')
    .trim()
    .slice(0, 24);
  awaitingName = false;
  if (!name) return false;
  memory.playerName = name.charAt(0).toUpperCase() + name.slice(1);
  saveMemory();
  const line = `${memory.playerName}! Great name. Okay — try me: tell me to do something. Anything. Oh, and the tomatoes are on Q… you'll want those on a bad day.`;
  logLine('n', `${npcDisplayName}: ${line}`);
  showBubble(line, 8);
  speak(line);
  // he knows your name now — bake it into the system prompt
  history[0] = { role: 'system', content: buildSystemPrompt(npcDisplayName, bootModelId, memoryBlock()) };
  saveHistory();
  return true;
}

// M2: the greeting is where the memory shows its teeth
function bootGreeting() {
  if (memory.sessions <= 1) {
    return `Hi! I'm ${npcDisplayName} — I live here, apparently for your amusement. What's your name?`;
  }
  const name = memory.playerName ? `, ${memory.playerName}` : '';
  let line;
  switch (lastStage) {
    case 'Nemesis':
      line = `Oh. It's you${name}. ${memory.punches} punches — I counted every single one. What do you want?`;
      break;
    case 'Resentful':
      line = `Back again${name}? My ribs remember last time. ${memory.punches} punches and counting.`;
      break;
    case 'Wary':
      line = `Oh — hi${name}. *takes a small step back* Good day so far? Let's keep it that way.`;
      break;
    case 'Friends':
      line = `Hey${name}! Good to see you — day ${memory.sessions} of us. The garden missed you.`;
      break;
    case 'Best Friends':
      line = `${memory.playerName || 'Boss'}!! You're back! Best part of my day. What are we doing?`;
      break;
    default:
      line = `Welcome back${name} — session ${memory.sessions}. Chores are on the board (J), tomatoes are wherever you left them.`;
  }
  if (!memory.playerName) line += ' Also — I never got your name?';
  return line;
}

function initHistory(systemPrompt) {
  // Try restoring from localStorage
  const saved = localStorage.getItem(`tiny-gta-history-${npcDisplayName}`);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 1) {
        // Replace system prompt with current one (in case it changed)
        parsed[0] = { role: 'system', content: systemPrompt };
        // Repair pre-fix sessions where a malformed model reply was stored
        // verbatim and then taught the model to echo `say` / `action` keys.
        history = parsed.map((m) => m?.role === 'assistant'
          ? { ...m, content: JSON.stringify(parseReply(m.content)) }
          : m);
        return;
      }
    } catch { /* fresh start */ }
  }
  history = [{ role: 'system', content: systemPrompt }];
}

function saveHistory() {
  try {
    // Cap at 20 (system + last 19). Fewer messages = smaller prompt = faster
    // replies; long-term continuity lives in the [memory] block, not history.
    if (history.length > 20) history.splice(1, history.length - 20);
    localStorage.setItem(`tiny-gta-history-${npcDisplayName}`, JSON.stringify(history));
  } catch { /* storage full — no big deal */ }
}

// P0-2: deterministic fallback command mapper (EN + HI + Hinglish).
// NOTE: JS \b does not work adjacent to Devanagari (it's ASCII-word-based),
// so Hindi keywords live in separate un-anchored alternatives.
const COMMAND_MAP = [
  { re: /\b(get\s+to\s+work|do\s+(your|the)\s+chores|start\s+working|kaam\s+karo?)\b|काम\s*कर/i, action: 'work' },
  { re: /\b(wash\s+(the\s+)?(car|falcon)|gaadi\s+dho)\b|गाड़ी\s*धो/i, action: 'wash_falcon' },
  { re: /\b((tidy|clean)\s+(up\s+)?(the\s+)?table|mez\s+saaf|table\s+saaf)\b|टेबल\s*साफ|मेज़?\s*साफ/i, action: 'tidy_table' },
  { re: /\b(hide|chhup\s+ja)\b|छुप/i, action: 'hide' },
  { re: /\b(copy\s+me|mimic\s+me|imitate\s+me|meri\s+nakal|nakal\s+karo?)\b|नकल\s*कर/i, action: 'mimic' },
  { re: /\b(go\s+on\s+strike|strike\s+karo?|picket|hadtaal)\b|हड़ताल|हड़ताल\s*कर/i, action: 'picket' },
  { re: /\b(throw\s+(a\s+)?tomato|tamatar\s+phenko?)\b|टमाटर\s*फेंक/i, action: 'throw_tomato' },
  { re: /\b(take\s+revenge|badla\s+lo?|ulta\s+karo?|do\s+the\s+opposite)\b|बदला\s*ल|उल्टा\s*कर/i, action: 'invert' },
  { re: /\b(sit\s+in\s+(the\s+)?car|car\s+me\s+baitho)\b|कार\s*में\s*बैठ/i, action: 'sit_in_car' },
  { re: /\b(jump\s+on\s+(the\s+)?table|table\s+pe\s+kood)\b|टेबल\s*पे\s*कूद/i, action: 'jump_on_table' },
  { re: /\b(sit\s+on\s+(the\s+)?table|table\s+pe\s+baitho?)\b|टेबल\s*पे\s*बैठ|मेज़?\s*पे\s*बैठ/i, action: 'sit_on_table' },
  { re: /\b(lie\s+(down\s+)?(on\s+)?(the\s+)?bed|sleep|so\s+ja)\b|लेट\s*जा|सो\s*जा/i, action: 'lie_on_bed' },
  { re: /\b(eat\s+(the\s+)?grass|ghaas?\s+khao?)\b|घास\s*खा/i, action: 'eat_grass' },
  { re: /\b(cut\s+(the\s+)?grass|mow|ghaas?\s+kaat)\b|घास\s*काट/i, action: 'cut_grass' },
  { re: /\b(crawl|creep|reng)\b|रेंग/i, action: 'crawl' },
  { re: /\b(jump|kood|kudo)\b|कूद/i, action: 'jump' },
  { re: /\b(sit|baitho?)\b|बैठ/i, action: 'sit' },
  { re: /\b(dance|nacho?|naach)\b|नाच/i, action: 'dance' },
  { re: /\b(follow|peeche)\b|पीछे/i, action: 'follow' },
  { re: /\b(come\s*(here|to\s+me)?|aa\s*jao?|idhar\s+aa)\b|इधर\s*आ|यहाँ\s*आ|आ\s*जा/i, action: 'come' },
  { re: /\b(stay|ruko?|stop|wait)\b|रुक/i, action: 'stay' },
  { re: /\b(wave|haath\s+hila)\b|हाथ\s*हिला/i, action: 'wave' },
  { re: /\b(water\s+(the\s+)?plants?|paudhe.*paani|paani.*paudhe)\b|पौधों?\s*को\s*पानी|पानी\s*डाल/i, action: 'water_plants' },
  { re: /\b(watch\s+tv|tv\s+dekho)\b|टीवी\s*देख/i, action: 'watch_tv' },
  { re: /\b(open\s+(the\s+)?fridge|fridge\s+kholo)\b|फ्रिज\s*खोल/i, action: 'open_fridge' },
  // drive BEFORE goto:car, else the bare "गाड़ी" in goto:car swallows "गाड़ी चला".
  // "gaadi chala" sits OUTSIDE the \b group so "chalao"/"chalaao" still match.
  { re: /\b(drive|joy\s*ride)\b|gaadi\s+chala|गाड़ी\s*चला/i, action: 'drive' },
  { re: /\b(go\s+to\s+(the\s+)?car|gaadi\s+ke\s+paas)\b|गाड़ी/i, action: 'goto:car' },
  { re: /\b(go\s+to\s+(the\s+)?bed|bistar)\b|बिस्तर/i, action: 'goto:bed' },
  { re: /\b(go\s+to\s+(the\s+)?kitchen)\b|रसोई/i, action: 'goto:kitchen' },
  { re: /\b(go\s+outside|bahar\s+jao?)\b|बाहर\s*जा/i, action: 'goto:yard' },
  { re: /\b(go\s+to\s+(the\s+)?garden)\b|बगीचे?\s*(में)?\s*जा/i, action: 'goto:garden' },
  { re: /\b(stand( up)?|khade?\s+ho|get\s+up|utho?)\b|खड़े?\s*हो|उठ/i, action: 'stand' },
  { re: /\b(read|padho?)\b|पढ़/i, action: 'read' },
  { re: /\b(wander|ghoomo?)\b|घूम/i, action: 'wander' },
  { re: /\b(flee|bhaag|run\s+away)\b|भाग/i, action: 'flee' },
  { re: /\b(run|zoomies|daud)\b|दौड़/i, action: 'run' },
  { re: /\bselfie|(take\s+(a\s+)?)?photo\s+(kheecho?|lo)|फोटो|सेल्फी/i, action: 'selfie' },
];

// "jump 4 times" / "jump twice" / "chaar baar kood" → jump:<n>
const NUM_WORDS = { two: 2, twice: 2, three: 3, thrice: 3, four: 4, five: 5, do: 2, teen: 3, chaar: 4, char: 4, paanch: 5, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5 };
function commandFromText(text) {
  // [\p{L}\p{M}]+ (not \p{L}+): Devanagari vowel signs are combining Marks
  const jm = text.match(/(?:jump|kood|kudo|कूद[\p{L}\p{M}]*)\s+(?:(\d+)|([\p{L}\p{M}]+))(?:\s*(?:times|baar|बार))?/iu)
        || text.match(/(?:(\d+)|([\p{L}\p{M}]+))\s*(?:times|baar|बार)\s*(?:jump|kood|कूद)/iu);
  if (jm) {
    const n = jm[1] ? parseInt(jm[1], 10) : NUM_WORDS[(jm[2] || '').toLowerCase()];
    if (n >= 2) return `jump:${Math.min(n, 8)}`;
  }
  for (const cmd of COMMAND_MAP) {
    if (cmd.re.test(text)) return cmd.action;
  }
  return null;
}

const clockStr = () => {
  const h = Math.floor(gameMinutes / 60) % 24, m = Math.floor(gameMinutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

function observation() {
  const d = npc.group.position.distanceTo(player.group.position).toFixed(1);
  const psychoTag = performance.now() < psycho.until ? '; YOU ARE IN PSYCHO MODE' : '';
  const plucked = flowers.filter((f) => f.plucked).length;
  const gardenTag = plucked ? `; flowers plucked from your garden: ${plucked}/8` : '';
  // PRIVATE stage direction — the model must let this shape mood/word-choice
  // but never recite the raw numbers (see persona rule 10b + scrubSceneLeak).
  return `[scene — PRIVATE context, do NOT recite these values aloud: you are in the ${roomOf(npc.group.position)}; the player is ${d}m away in the ${roomOf(player.group.position)}, ${seen.activity}; time ${clockStr()}; you are currently ${npcState.mode === 'goto' ? 'walking somewhere' : npcState.mode}; happiness ${Math.round(mood.happiness)}/10; tokens eaten ${mood.fedTokens}; recent hits ${npcState.punchCount}${gardenTag}${psychoTag}]`;
}

function logLine(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// Small models under decoding pressure sometimes loop a token before
// breaking into real content ("say say say say Narendra Modi") — collapse
// any run of 3+ identical consecutive words (nobody says a word 4x on purpose).
const REPEAT_RUN_RE = /\b(\w+)(?:\s+\1\b){2,}\s*/gi;
const PROTOCOL_KEYS = new Set(['say', 'reply', 'text', 'message', 'action', 'act', 'mood']);
function dequeueKeyEchoes(text) {
  const words = text.split(/\s+/);
  let i = 0;
  while (i < words.length && PROTOCOL_KEYS.has(words[i].replace(/[:",]/g, '').toLowerCase())) i++;
  return i ? words.slice(i).join(' ') : text;
}
// Narrow, high-precision: strips only the exact schema-echo fingerprint
// "action <word> mood <word>" at the very END of a string. Anchored to both
// keywords + end-of-string so organic sentences merely containing "action"
// or "mood" survive untouched — see server.py's TRAIL_SCHEMA_RE for the
// verified false-positive test cases (this is the same pattern).
const TRAIL_SCHEMA_RE = /\s+action\s+\S{1,24}\s+mood\s+\S{1,24}\s*$/i;

function parseReply(raw) {
  let say = '', action = 'none', mood = '';
  const s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*|```/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const jsonStr = s.slice(a, b + 1);
    try {
      const j = JSON.parse(jsonStr);
      say = String(j.say ?? j.reply ?? j.text ?? j.message ?? '').trim();
      action = String(j.action ?? j.act ?? 'none').toLowerCase().trim();
      mood = String(j.mood ?? '').trim();
    } catch {
      // Small local models occasionally produce valid-looking JSON with one
      // unescaped quote. Extract fields independently so protocol keys never
      // leak into the chat bubble as plain text.
      const field = (key) => {
        const m = jsonStr.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 'is'));
        return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim() : '';
      };
      say = field('say') || field('reply') || field('text') || field('message');
      action = field('action') || field('act') || 'none';
      mood = field('mood');
    }
  }
  if (!say) {
    // Plain-text answers are still useful. For malformed protocol replies,
    // remove the transport keys instead of showing "say/action/mood" to the player.
    say = s.replace(/[{}]/g, '')
      .replace(/"?(?:say|reply|text|message|action|act|mood)"?\s*:/gi, '')
      .replace(/"/g, '').trim();
    say = dequeueKeyEchoes(say);
    say = say.replace(TRAIL_SCHEMA_RE, '');
  }
  say = say.replace(REPEAT_RUN_RE, '').trim();
  say = scrubSceneLeak(say);
  say = say.slice(0, 1200) || '…';
  return { say, action: action.toLowerCase().trim() || 'none', mood };
}

// Small models sometimes recite the private [scene] block back to the player
// ("You're 31 meters away and I'm at 6/10 happiness"). Drop any sentence that
// quotes those raw stat values; keep everything else. If it would empty the
// line, keep the original (a clean reply beats an empty one).
const SCENE_LEAK_RE = /\b\d+(\.\d+)?\s*(m|met(er|re)s?)\s+(away|from)|\bhappiness\s*(is|at|:)?\s*\d+\s*\/?\s*10|\b\d+\s*\/\s*10\s*(happiness|mood)|\brecent hits?\b|\btokens?\s+eaten\b|\bmovement mode\b/i;
function scrubSceneLeak(text) {
  if (!SCENE_LEAK_RE.test(text)) return text;
  const sentences = text.match(/[^.!?…]+[.!?…]*/g) || [text];
  const kept = sentences.filter((s) => !SCENE_LEAK_RE.test(s)).join(' ').replace(/\s+/g, ' ').trim();
  return kept || text;
}

async function sendToBrain(text, _lastUserText) {
  if (brainBusy) return;
  if (performance.now() < npcState.koUntil) {
    logLine('sys', "(he's rebooting — nobody's home right now)");
    return;
  }
  if (!text.startsWith('[')) {
    if (awaitingName && !commandFromText(text) && text.trim().split(/\s+/).length <= 4 && text.length < 30) {
      if (captureName(text)) return;
    }
    awaitingName = false;
    stats.messages++;
    if (stats.messages >= 10) ach('therapy', 'Certified Therapy Session — 10 messages vented');
    if (INSULT_RE.test(text)) { stats.insults++; memAdd('insults'); ach('trash', 'Trash Talker — verbal abuse delivered'); }
    // M4: a sincere apology settles the strike
    if (strike.active && /\b(sorry|apolog|maaf|forgive)/i.test(text) && text.trim().length > 8) {
      endStrike('the player apologized sincerely');
    }
  }
  brainBusy = true;
  const displayName = npcDisplayName || NPC_NAME;
  statusEl.textContent = `${displayName} is thinking…`;
  chatSend.disabled = true;
  const userText = _lastUserText || text;
  history.push({ role: 'user', content: `${observation()}\n${text}` });
  if (history.length > 20) history.splice(1, history.length - 20);
  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    let { say, action, mood: replyMood } = parseReply(data.reply);
    // Never feed a malformed raw reply back to the model; one broken turn used
    // to teach the next turn to print its JSON keys in the visible dialogue.
    history.push({ role: 'assistant', content: JSON.stringify({ say, action, mood: replyMood }) });

    // P0-2: deterministic obedience — if the model returned none/stay but the
    // user clearly commanded an action, force it… unless he's genuinely
    // miserable (happiness < 2), in which case the refusal STANDS and the
    // player must bribe (G) or slap (click) to get compliance. That's the game.
    let commanded = commandFromText(userText);
    // psycho mode: nothing gets through — he doesn't do tricks anymore
    if (commanded && performance.now() < psycho.until) {
      commanded = null;
      action = 'none';
    }
    // M4: the picket line holds — no commands get through a strike
    if (strike.active && commanded) {
      action = 'none';
      logLine('sys', '(ON STRIKE — two tokens [G] or an apology first)');
      if (challenge.id === 'rage') challengeWin();
      commanded = null;
    }
    // M4: revenge patch v2.0 — commands invert, and he loves it
    if (commanded && revenge.invertUntil > performance.now()) {
      const base = commanded.split(':')[0];
      if (INVERT_MAP[base]) {
        commanded = INVERT_MAP[base];
        action = commanded;
        showBubble('*cackles* v2.0, baby!', 2.5);
      }
    }
    if (commanded && (action === 'none' || action === 'stay')) {
      if (mood.happiness >= 2) {
        action = commanded;
      } else {
        npcState.refusedCommand = commanded;
        logLine('sys', `(${npcDisplayName} refused — feed a token [G] or… persuade him)`);
        if (challenge.id === 'rage') challengeWin();
      }
    } else if (commanded) {
      npcState.refusedCommand = null;
    }

    // P1-7: long-answer UX — code/long replies go fully into log, bubble skipped
    if (say.length > 250) {
      const div = document.createElement('div');
      div.className = 'n';
      // Render code blocks with monospace
      const rendered = say.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
                          .replace(/`([^`]+)`/g, '<code>$1</code>')
                          .replace(/\n/g, '<br>');
      div.innerHTML = `<strong>${displayName}:</strong> ${rendered}`;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    } else {
      logLine('n', `${displayName}: ${say}`);
      showBubble(say, Math.max(4, say.length * 0.07));
    }

    speak(say);
    if (say.length > 8 && say.length < 140) sessionQuotes.push(say); // receipt material
    // real talking gesture while he speaks (only when not walking somewhere)
    if (!npcState.route.length && npcState.mode !== 'follow' && say.length > 12) {
      npc.anim.gesture(['talking'], Math.min(6, 1.5 + say.length * 0.03));
    }
    applyAction(action);
    if (action && action !== 'none' && !text.startsWith('[')) { stats.obeyed++; memAdd('obeyed'); }
    saveHistory();
    statusEl.textContent = replyMood ? `${modelLabel} · ${displayName} feels ${replyMood}` : modelLabel;
  } catch (e) {
    logLine('sys', `(brain error: ${e.message})`);
    statusEl.textContent = modelLabel;
  } finally {
    brainBusy = false;
    chatSend.disabled = false;
    if (chatOpen) chatInput.focus();
    // Drain one queued event/message at a time so history stays in order.
    if (pendingMessages.length) {
      sendToBrain(pendingMessages.shift());
    }
  }
}

// ------------------------------------------------------------- actions ---
function setRoute(targetXZ, after = null, mode = 'goto') {
  // Sitting on furniture raises the character's floor. Reset that state the
  // moment a new trip begins, otherwise he can walk away hovering in mid-air.
  if (npcState.floorY > 0) {
    npcState.floorY = 0;
    npcState.vy = 0;
    npc.group.position.y = 0;
  }
  const clear = findClearNear(targetXZ[0], targetXZ[1]);
  npcState.route = routeTo(npc.group.position, clear[0], clear[1]);
  npcState.finalTarget = clear;
  npcState.after = after;
  npcState.mode = mode;
  npcState.stuckCount = 0;
}

// Plant him ON a surface (sofa, table, car seat, bed) in a frozen crouch pose.
// The old code raised floorY while he stood NEXT to the furniture, so he
// levitated at seat height in mid-air — the reported "can't sit in car" bug.
function seatNpc(x, z, height, faceYaw = null, secs = 20) {
  npc.group.position.set(x, height, z);
  npcState.floorY = height;
  npcState.vy = 0;
  if (faceYaw !== null) npc.group.rotation.y = faceYaw;
  npc.anim.gesture(['crawl', 'sitting', 'sit'], secs, true); // frozen crouch ≈ seated
  npcState.mode = 'stay';
  npcState.stayUntil = performance.now() + secs * 1000 + 5000;
}

// The Falcon MOVES now (player drives it around) — every car-related walk
// target must chase its live position, not the original parking spot
function carSpot() {
  const h = falconGroup.rotation.y;
  return findClearNear(
    falconGroup.position.x - Math.cos(h) * 1.7,
    falconGroup.position.z + Math.sin(h) * 1.7,
  );
}

function applyAction(action) {
  const [verb, arg] = action.split(':').map((s) => s?.trim());
  switch (verb) {
    case 'nod': if (!npc.anim.gesture(['agree', 'yes', 'nod'], 1.4)) startProc('nod', 1.2); break;
    case 'shake': if (!npc.anim.gesture(['headshake', 'no'], 1.4)) startProc('shake', 1.2); break;
    case 'wave': if (!npc.anim.gesture(['wave'], 1.6)) startProc('wave', 1.4); break;
    case 'dance': {
      // a full 16-second performance, with attention-fishing commentary
      const now = performance.now();
      show.danceUntil = now + 16000;
      show.nextLine = now + 1800;
      show.lineIdx = 0;
      if (!npc.anim.gesture(['dance'], 16)) { npcState.spinUntil = now + 14000; startProc('dance', 14); }
      break;
    }
    case 'run': {
      // zoomies: sprint laps between random spots for ~9 seconds
      show.zoomiesUntil = performance.now() + 9000;
      let far = null, farD = -1;
      for (const w of WANDER_SPOTS) {
        const p = PLACES[w];
        const d = (p[0] - npc.group.position.x) ** 2 + (p[1] - npc.group.position.z) ** 2;
        if (d > farD) { farD = d; far = p; }
      }
      setRoute(far, null, 'flee-goto');
      showBubble('ZOOMIES!', 2);
      break;
    }
    case 'drive':
      // he no longer drives solo — he walks to the Falcon and waits shotgun
      // for YOU to get in and drive
      if (car.inCar || car.passenger) { showBubble('I\'m already in, chalao!', 2.5); break; }
      setRoute(carSpot(), 'npc_drive');
      break;
    case 'selfie': {
      // run to the player's side and pose for the camera
      const p = player.group.position;
      const side = _v4.set(Math.cos(camYaw), 0, -Math.sin(camYaw)); // camera-right
      setRoute(findClearNear(p.x + side.x * 0.9, p.z + side.z * 0.9), 'selfie');
      break;
    }
    case 'jump': {
      const n = Math.min(parseInt(arg, 10) || 1, 8);
      npcState.jumpQueue = n - 1;
      if (npc.group.position.y <= npcState.floorY + 0.01) { npcState.vy = 5.2; npc.anim.gesture(['jump'], 0.9); }
      break;
    }
    case 'crawl': {
      // drop to a crouch-crawl and creep a few meters forward
      npcState.crawlUntil = performance.now() + 9000;
      const fwd = new THREE.Vector3(Math.sin(npc.group.rotation.y), 0, Math.cos(npc.group.rotation.y));
      const tx = npc.group.position.x + fwd.x * 4, tz = npc.group.position.z + fwd.z * 4;
      setRoute([Math.max(-34, Math.min(34, tx)), Math.max(-8.5, Math.min(36, tz))]);
      break;
    }
    case 'eat_grass':
      setRoute(PLACES.lawn, 'eat_grass');
      break;
    case 'sleep':
      setRoute(PLACES.bed, 'lie_on_bed');
      break;
    case 'come': {
      // walk right up to the player, wherever they are
      const p = player.group.position;
      const dir = npc.group.position.clone().sub(p).setY(0).normalize();
      setRoute([p.x + dir.x * 1.3, p.z + dir.z * 1.3]);
      break;
    }
    case 'follow': mimicUntil = 0; npcState.mode = 'follow'; npcState.route = []; npcState.followRouteAge = 9; break;
    case 'stay': npcState.mode = 'stay'; npcState.stayUntil = performance.now() + 60000; npcState.route = []; break;
    case 'wander': npcState.mode = 'wander'; npcState.waitUntil = 0; npcState.route = []; break;
    case 'flee': {
      let best = null, bestD = -1;
      for (const w of WANDER_SPOTS) {
        const p = PLACES[w];
        const d = (p[0] - player.group.position.x) ** 2 + (p[1] - player.group.position.z) ** 2;
        if (d > bestD) { bestD = d; best = p; }
      }
      setRoute(best, null, 'flee-goto');
      if (challenge.id === 'rage') challengeWin();
      break;
    }
    case 'sit': setRoute(PLACES.sofa, 'sit'); break;
    case 'read': setRoute(PLACES.book, 'read'); break;

    // P1-3: expanded actions
    case 'sit_in_car':
      if (car.inCar) { showBubble("…you're in my seat.", 3); break; }
      setRoute(carSpot(), 'sit_in_car');
      break;
    case 'sit_on_table':
      setRoute(PLACES.table, 'sit_on_table');
      break;
    case 'jump_on_table':
      setRoute(PLACES.table, 'jump_on_table');
      break;
    case 'lie_on_bed':
      setRoute(PLACES.bed, 'lie_on_bed');
      break;
    case 'cut_grass': {
      // Generate mow waypoints: back-and-forth sweep of the lawn
      const waypoints = [];
      for (let i = 0; i < 6; i++) {
        const x = -5 + i * 1.8;
        waypoints.push([x, 7.5], [x, 9.5]);
      }
      npcState.mowWaypoints = waypoints;
      npcState.mowIdx = 0;
      setRoute(PLACES.lawn, 'cut_grass');
      break;
    }
    case 'water_plants':
      setRoute(PLACES.garden, 'water_plants');
      break;
    case 'watch_tv':
      setRoute(PLACES.sofa, 'watch_tv');
      break;
    case 'open_fridge':
      setRoute(PLACES.fridge, 'open_fridge');
      break;
    case 'stand': {
      npcState.mode = 'stay';
      npcState.stayUntil = performance.now() + 30000;
      npcState.route = [];
      npcState.after = null;
      if (npcState.floorY > 0) {
        // step down to actual clear ground, not into the furniture he was on
        const [gx, gz] = findClearNear(npc.group.position.x + 0.8, npc.group.position.z);
        npc.group.position.set(gx, 0, gz);
      }
      npcState.floorY = 0;
      npc.anim.gestureUntil = 0; // release any frozen seated pose
      break;
    }

    // M3: chore actions
    case 'wash_falcon': setRoute(carSpot(), 'wash_falcon'); break;
    case 'tidy_table': setRoute(PLACES.table, 'tidy_table'); break;
    case 'work': startWork(); break;

    // M4: agency — pranks & revenge (also model-invokable)
    case 'hide': {
      const spots = [[-8, -6.2], [7.8, -6.2], [8.8, 0.5], [-8, 0.5]];
      let best = spots[0], bestD = -1;
      for (const s of spots) {
        const d = (s[0] - player.group.position.x) ** 2 + (s[1] - player.group.position.z) ** 2;
        if (d > bestD) { bestD = d; best = s; }
      }
      setRoute(best, 'hide');
      break;
    }
    case 'mimic':
      mimicUntil = performance.now() + 15000;
      npcState.mode = 'follow';
      npcState.route = [];
      npcState.followRouteAge = 9;
      showBubble('*sneaks up behind you, copying your walk*', 3);
      break;
    case 'picket': startStrike(); break;
    case 'throw_tomato': npcThrowTomato(); break;
    case 'invert': startInvert(); break;

    case 'goto': if (arg === 'car') setRoute(carSpot()); else if (arg && PLACES[arg]) setRoute(PLACES[arg]); break;
    default: break;
  }
}

// ------------------------------------------------------------- bubble ---
let bubbleUntil = 0;
function showBubble(text, secs = 5) {
  bubbleTxt.textContent = text;
  bubbleEl.style.display = 'block';
  bubbleUntil = performance.now() + secs * 1000;
}

// ---------------------------------------------------------------- chat ---
function openChat() {
  chatOpen = true;
  chatEl.style.display = 'flex';
  promptEl.style.display = 'none';
  document.exitPointerLock?.();
  if (npcState.mode === 'wander') { npcState.mode = 'stay'; npcState.stayUntil = performance.now() + 45000; }
  if (!logEl.childElementCount) logLine('sys', `You walk up to ${npcDisplayName}.`);
  setTimeout(() => chatInput.focus(), 30);
}
function closeChat() {
  chatOpen = false;
  chatEl.style.display = 'none';
  chatInput.blur();
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || brainBusy) return;
  chatInput.value = '';
  logLine('u', `You: ${text}`);
  sendToBrain(text);
});

// --------------------------------------------------------------- input ---
addEventListener('keydown', (e) => {
  if (chatOpen) {
    if (e.key === 'Escape') closeChat();
    return;
  }
  initAudio(); // any gesture unlocks game audio
  keys[e.code] = true;
  if (e.code === 'KeyT' && !e.repeat) startListening();
  // typed chat (E) — the fallback when the mic can't work (no internet, no
  // permission, Safari) and the only way to read the conversation log
  if (e.code === 'KeyE' && !e.repeat && !car.inCar) openChat();
  if (e.code === 'KeyG' && !e.repeat && !car.inCar) feedToken();
  if (e.code === 'KeyQ' && !e.repeat && !car.inCar) throwTomato();
  if (e.code === 'KeyP' && !e.repeat) pluckFlower();
  if (e.code === 'KeyF' && !e.repeat) toggleCar();
  if (e.code === 'KeyR' && !e.repeat && !car.inCar &&
      player.group.position.distanceTo(falconGroup.position) < 3.6) repairCar();
  if (e.code === 'Tab' && !e.repeat) { e.preventDefault(); toggleStats(); }
  if (e.code === 'KeyJ' && !e.repeat) toggleBoard();
  if (e.code === 'KeyC' && !e.repeat) toggleChallenges();
  if (e.code === 'KeyO' && !e.repeat) toggleSettings();
  if (/^Digit[123]$/.test(e.code) &&
      document.getElementById('challenges').style.display === 'block') {
    startChallenge(['rage', 'citizen', 'marathon'][+e.code.slice(-1) - 1]);
  }
  if (e.code === 'KeyV' && !e.repeat) {
    voiceOn = !voiceOn;
    if (!voiceOn) stopSpeaking();
    statusEl.textContent = `${modelLabel} · voice ${voiceOn ? 'on' : 'off'}`;
  }
  if (e.code === 'Space' && playerState.grounded) {
    playerState.vy = 5.4; playerState.grounded = false;
    seen.jumps++;
    e.preventDefault();
  }
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'KeyT') stopListening();
});

let chargeStart = 0;
addEventListener('blur', () => {
  // Browsers do not always deliver matching keyup/mouseup events after focus
  // changes; reset controls so movement and punch charging cannot get stuck.
  for (const code of Object.keys(keys)) keys[code] = false;
  chargeStart = 0;
  chargeEl.style.display = 'none';
  stopListening();
});
renderer.domElement.addEventListener('mousedown', () => {
  if (chatOpen) return;
  initAudio();
  if (!pointerLocked) { renderer.domElement.requestPointerLock(); return; }
  if (car.inCar) { // click = horn
    hornSound();
    if (npc.group.position.distanceTo(falconGroup.position) < 7) {
      showBubble('*flinches*', 1.2);
      if (!npc.anim.gesture(['headshake'], 0.8)) startProc('shake', 0.7);
    }
    return;
  }
  chargeStart = performance.now();
  chargeEl.style.display = 'block';
});
addEventListener('mouseup', () => {
  if (!chargeStart) return;
  const power = Math.min(1, (performance.now() - chargeStart) / 1100);
  chargeStart = 0;
  chargeEl.style.display = 'none';
  if (!pointerLocked || chatOpen || car.inCar) return;
  punch(power);
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
addEventListener('mousemove', (e) => {
  if (!pointerLocked || chatOpen) return;
  camYaw -= e.movementX * 0.0026 * settings.sens;
  camPitch = Math.max(-0.35, Math.min(1.05, camPitch + e.movementY * 0.0026 * settings.sens));
});

function sendEvent(text) {
  // Events must never be lost — queue them if the brain is mid-thought.
  if (brainBusy) queueBrainMessage(text);
  else sendToBrain(text);
}

function punch(power = 0) {
  const now = performance.now();
  if (now - playerState.lastPunch < 700) return;
  playerState.lastPunch = now;
  const d = npc.group.position.distanceTo(player.group.position);
  if (d > CFG.punchRange) return;
  if (now < npcState.koUntil) { punchSound(); return; } // he's already out cold
  const dir = npc.group.position.clone().sub(player.group.position).setY(0).normalize();
  // face him toward the player so he falls backwards, away from the hit
  npc.group.rotation.y = Math.atan2(-dir.x, -dir.z);
  npcState.knock.copy(dir.multiplyScalar(5.0 + power * 7.5));
  if (power > 0.55) { npcState.vy = 2.5 + power * 2; } // haymakers launch him
  // P1-8: punch count tracking with escalation
  npcState.punchCount++;
  const hitNum = npcState.punchCount;
  mood.happiness = Math.max(0, mood.happiness - 2);
  stats.punches++;
  memAdd('punches');
  hitJuice(power);
  ach('firstblood', 'First Blood — you punched an AI');
  if (stats.punches >= 10) ach('anger', 'Anger Management Needed — 10 punches');
  if (power > 0.55) { stats.heavyPunches++; memAdd('heavyPunches'); ach('haymaker', 'Haymaker — fully charged hit'); }
  // P1-8: longer down time after 5+ rapid hits; heavy hits floor him longer
  const downTime = (hitNum >= 5 ? 2800 : 1650) + power * 900;
  npcState.downUntil = now + downTime;
  startProc('knockdown', downTime / 1000);
  punchSound();
  logLine('sys', `You punched ${npcDisplayName} — hit #${hitNum}${power > 0.55 ? ' (HAYMAKER)' : ''}.`);
  // 7 hits inside the decay window = full system crash
  if (hitNum >= 7) { triggerKO(); return; }
  // rock bottom + a sustained beating = something in him goes quiet
  if (mood.happiness <= 0.5 && hitNum >= 5 && performance.now() >= psycho.until) {
    setTimeout(() => startPsycho(), downTime + 200);
    return; // no apologetic "Ow" — the silence IS the reaction
  }
  // P1-8: instant "Ow!" feedback
  speak(hitNum >= 3 ? 'Stop it!' : "Ow! I'm sorry!");
  // fear-based compliance: one slap after a refusal gets the job done (hits 1-2)
  if (npcState.refusedCommand && hitNum <= 2) {
    const c = npcState.refusedCommand;
    npcState.refusedCommand = null;
    setTimeout(() => applyAction(c), downTime + 300);
  }
  // M4: repeated abuse at a hostile stage → he organizes
  const st = relationshipStage();
  if (hitNum >= 4 && !strike.active && (st === 'Resentful' || st === 'Nemesis')) {
    setTimeout(() => startStrike(), downTime + 400);
  }
  sendEvent(`[event] The player just punched you and knocked you down${power > 0.55 ? ' with a massive charged haymaker' : ''}. Hit #${hitNum} in the last minute. Happiness now ${Math.round(mood.happiness)}/10.`);
}

function feedToken() {
  const now = performance.now();
  if (now - mood.lastFeed < 800) return;
  const d = npc.group.position.distanceTo(player.group.position);
  if (d > 2.8) { micStatus('get closer to feed him a token 🪙'); setTimeout(micHide, 1400); return; }
  mood.lastFeed = now;
  mood.fedTokens++;
  mood.happiness = Math.min(10, mood.happiness + 1.6);
  stats.tokens++;
  memAdd('tokens');
  if (stats.tokens >= 5) ach('sugar', 'Sugar Daddy — 5 tokens fed');
  if (mood.happiness >= 10) ach('nice', 'Wait, You\'re Actually Nice?! — max happiness');
  chompSound();
  coinSound();
  // M3/M4: a token settles a lot of scores
  if (challenge.id === 'citizen') challengeFail('you fed a token');
  if (revenge.invertUntil > now) {
    revenge.invertUntil = 0;
    showBubble('*sigh* Fine. Patch rolled back. You buy cheap loyalty.', 3.5);
  }
  if (strike.active) {
    strike.fedDuring++;
    if (strike.fedDuring >= 2) endStrike('the player paid the 2-token settlement');
    else showBubble('*eyes the token* One more. That was the deal.', 4);
  }
  showBubble('*gulps down the data token* 🪙', 2.5);
  npc.anim.gesture(['talking', 'agree'], 1.6);
  logLine('sys', `You fed ${npcDisplayName} a data token (happiness ${Math.round(mood.happiness)}/10, total 🪙${mood.fedTokens}).`);
  // a token snaps him out of psycho mode — food-based exorcism
  endPsycho('token fed');
  // bribe-based compliance: a fed NPC does what he was refusing
  if (npcState.refusedCommand) {
    const c = npcState.refusedCommand;
    npcState.refusedCommand = null;
    setTimeout(() => applyAction(c), 1400);
  }
  // batched: rapid-fire feeding produces ONE combined reaction, not one
  // slow LLM reply per keypress (the local chomp/coin/bubble stay instant)
  queueBurst('feeds', 1600, (n) => n === 1
    ? `[event] The player fed you a delicious data token! Happiness now ${Math.round(mood.happiness)}/10 (${mood.fedTokens} total). If you were refusing or angry, you feel much more agreeable now.`
    : `[event] The player just fed you ${n} data tokens in a row — a FEAST. Happiness now ${Math.round(mood.happiness)}/10 (${mood.fedTokens} total). You are delighted and very agreeable.`);
}

// --------------------------------------------------------------- update ---
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(),
      _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();

function updatePlayer(dt) {
  if (car.inCar) { player.anim.setBase(['idle']); return; }
  const fwd = _v1.set(Math.sin(camYaw), 0, Math.cos(camYaw));
  const right = _v2.set(-fwd.z, 0, fwd.x);
  let mx = 0, mz = 0;
  if (!chatOpen) {
    if (keys.KeyW) mz += 1;
    if (keys.KeyS) mz -= 1;
    if (keys.KeyD) mx += 1;
    if (keys.KeyA) mx -= 1;
  }
  const moving = mx !== 0 || mz !== 0;
  const running = moving && keys.ShiftLeft;
  const speed = running ? CFG.runSpeed : CFG.walkSpeed;

  if (moving) {
    // Reuse scratch vectors: allocating several vectors per frame caused small
    // but visible garbage-collection hitches during long play sessions.
    const dir = _v3.copy(fwd).multiplyScalar(mz).addScaledVector(right, mx).normalize();
    player.group.position.addScaledVector(dir, speed * dt);
    const targetYaw = Math.atan2(dir.x, dir.z);
    let dy = targetYaw - player.group.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    player.group.rotation.y += dy * Math.min(1, dt * 12);
    if (playerState.grounded) {
      playerState.stepAcc += dt;
      const interval = running ? 0.31 : 0.48;
      if (playerState.stepAcc >= interval) { playerState.stepAcc = 0; footstep(running); }
    }
  } else playerState.stepAcc = 0.3;

  playerState.vy += CFG.gravity * dt;
  player.group.position.y += playerState.vy * dt;
  if (player.group.position.y <= 0) {
    if (!playerState.grounded) footstep(true); // landing thump
    player.group.position.y = 0; playerState.vy = 0; playerState.grounded = true;
  }

  resolveCircle(player.group.position, CFG.playerRadius);

  // feed his "vision": what is the player doing right now?
  if (running) seen.sprintTime += dt;
  const pp = player.group.position;
  if (moving && pp.x > -9.5 && pp.x < -1 && pp.z > 7.4 && pp.z < 10.4) seen.gardenTrample += dt;
  if (Math.hypot(pp.x - falconGroup.position.x, pp.z - falconGroup.position.z) < 3.4) seen.nearCar += dt;
  seen.activity = !playerState.grounded ? 'jumping around' : running ? 'sprinting' : moving ? 'walking' : 'standing still';

  player.anim.setBase(moving ? (running ? ['run'] : ['walk']) : ['idle']);
}

// Push player and NPC apart symmetrically, then re-check both against walls.
// One-sided pushing is what caused the "stuck inside his body" oscillation.
function separateCharacters() {
  const sep = _v1.copy(player.group.position).sub(npc.group.position);
  sep.y = 0;
  const d = sep.length();
  const minSep = CFG.playerRadius + CFG.npcRadius;
  if (d >= minSep) return;
  const push = d > 0.001 ? sep.normalize() : sep.set(0, 0, 1);
  const overlap = minSep - d;
  player.group.position.addScaledVector(push, overlap * 0.5);
  npc.group.position.addScaledVector(push, -overlap * 0.5);
  resolveCircle(player.group.position, CFG.playerRadius);
  resolveCircle(npc.group.position, CFG.npcRadius);
}

function npcFace(target, dt, rate = 8) {
  const dx = target.x - npc.group.position.x, dz = target.z - npc.group.position.z;
  if (dx * dx + dz * dz < 0.001) return;
  const want = Math.atan2(dx, dz);
  let dy = want - npc.group.rotation.y;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  npc.group.rotation.y += dy * Math.min(1, dt * rate);
}

function npcMoveToward(target, speed, dt) {
  const dir = _v1.set(target.x - npc.group.position.x, 0, target.z - npc.group.position.z);
  const dist = dir.length();
  if (dist < 0.05) return 0;
  dir.normalize();
  // whisker steering: if the straight step hits a wall, slide around it
  // instead of grinding face-first into it
  const px = npc.group.position.x, pz = npc.group.position.z;
  if (pointHits(px + dir.x * 0.55, pz + dir.z * 0.55, CFG.npcRadius + 0.03)) {
    const base = Math.atan2(dir.x, dir.z);
    for (const off of [0.6, -0.6, 1.1, -1.1, 1.6, -1.6]) {
      const a = base + off;
      const dx = Math.sin(a), dz = Math.cos(a);
      if (!pointHits(px + dx * 0.55, pz + dz * 0.55, CFG.npcRadius + 0.03)) {
        dir.set(dx, 0, dz);
        break;
      }
    }
  }
  npc.group.position.addScaledVector(dir, Math.min(speed * dt, dist));
  npcFace(target, dt);
  return dist;
}

function advanceRoute(speed, dt) {
  const wp = npcState.route[0];
  if (!wp) return true;
  const dist = npcMoveToward(wp, speed, dt);
  if (dist < 0.45) npcState.route.shift();
  return npcState.route.length === 0;
}

function updateNPC(dt) {
  // riding shotgun — updateCar owns his position/pose; skip all AI/physics
  if (car.passenger) return;
  const now = performance.now();
  const pPos = player.group.position;
  const dToPlayer = npc.group.position.distanceTo(pPos);

  if (npcState.knock.lengthSq() > 0.01) {
    npc.group.position.addScaledVector(npcState.knock, dt);
    npcState.knock.multiplyScalar(Math.max(0, 1 - dt * 5));
  }
  npcState.vy += CFG.gravity * dt;
  npc.group.position.y = Math.max(npcState.floorY, npc.group.position.y + npcState.vy * dt);
  if (npc.group.position.y === npcState.floorY) {
    if (npcState.vy < -4) footstep(true); // landing thud
    npcState.vy = 0;
    // multi-jump queue ("jump 4 times")
    if (npcState.jumpQueue > 0) {
      npcState.jumpCooldown += dt;
      if (npcState.jumpCooldown > 0.25) {
        npcState.jumpCooldown = 0;
        npcState.jumpQueue--;
        npcState.vy = 5.2;
        npc.anim.gesture(['jump'], 0.9);
      }
    }
  }

  // happiness slowly drifts back toward neutral 6
  mood.happiness += (6 - mood.happiness) * dt * 0.012;

  // P1-8: decay punch count (1 per 60s)
  npcState.punchDecayTimer += dt;
  if (npcState.punchDecayTimer >= 60 && npcState.punchCount > 0) {
    npcState.punchCount--;
    npcState.punchDecayTimer = 0;
  }

  if (now < npcState.spinUntil) npc.group.rotation.y += dt * 8;

  let moving = false, running = false;

  // THINKING: stand still and face the player while the brain is working —
  // the floating 💭 loader (updateOverlays) shows why he's frozen
  if (brainBusy && now >= npcState.downUntil) {
    npcFace(pPos, dt, 6);
  // PSYCHO MODE: slow relentless stalk toward the player, then stare
  } else if (now < psycho.until && now >= npcState.downUntil) {
    npcState.route = [];
    if (dToPlayer > 2.3) {
      npcMoveToward(pPos, 0.95, dt);
      moving = true;
    } else npcFace(pPos, dt, 3);
    if (now > psycho.nextLine && !brainBusy) {
      psycho.nextLine = now + 6500 + Math.random() * 4000;
      const line = PSYCHO_LINES[(Math.random() * PSYCHO_LINES.length) | 0];
      showBubble(line, 4);
      speak(line);
      const dmg = document.getElementById('dmg');
      dmg.style.opacity = 0.22;
      setTimeout(() => { dmg.style.opacity = 0; }, 700);
    }
    if (now >= psycho.until) endPsycho('it passed… for now');
  // no locomotion while knocked down — he's busy hitting the floor
  } else if (now >= npcState.downUntil) switch (npcState.mode) {
    case 'goto':
    case 'flee-goto': {
      running = npcState.mode === 'flee-goto';
      moving = true;
      const crawlSpd = now < npcState.crawlUntil ? 0.85 : null;
      const arrived = advanceRoute(crawlSpd ?? (running ? CFG.npcRun : CFG.npcWalk), dt);
      if (arrived && !npcState.after && now < show.zoomiesUntil) {
        // zoomies: immediately sprint to the next random spot
        const spot = PLACES[WANDER_SPOTS[(Math.random() * WANDER_SPOTS.length) | 0]];
        setRoute(spot, null, 'flee-goto');
        break;
      }
      if (arrived) {
        npcState.mode = 'stay';
        npcState.stayUntil = now + (npcState.after ? 90000 : 45000);
        const afterAction = npcState.after;
        if (afterAction && EMOTES[afterAction]) {
          showBubble(EMOTES[afterAction], 5);
        }
        // P1-3: handle expanded after-actions
        switch (afterAction) {
          case 'sit':
            // ON the sofa cushion, facing out into the room
            seatNpc(2.4, -1.6, 0.78, 0);
            break;
          case 'watch_tv':
            // ON the sofa, facing the TV (which is at -z)
            seatNpc(2.4, -1.6, 0.78, Math.PI);
            break;
          case 'sit_in_car': {
            // INTO the driver's seat of wherever the Falcon actually is —
            // seated LOW (0.28, same math as the passenger in updateCar) so
            // he sits inside the open cabin, not with his head through the roof
            const fp = falconGroup.position, hh = falconGroup.rotation.y;
            const ch = Math.cos(hh), sh = Math.sin(hh);
            const rx = -0.42, fz = 0.1;   // car-local: driver side, slightly forward
            seatNpc(fp.x + ch * rx + sh * fz, fp.z - sh * rx + ch * fz, 0.28, hh);
            break;
          }
          case 'sit_on_table':
            seatNpc(1.7, 1.8, 0.75, Math.atan2(pPos.x - 1.7, pPos.z - 1.8));
            break;
          case 'jump_on_table':
            seatNpc(1.7, 1.8, 0.75, Math.atan2(pPos.x - 1.7, pPos.z - 1.8));
            npcState.vy = 3.4; // hop up with some flair
            npc.anim.gesture(['jump'], 0.8);
            break;
          case 'lie_on_bed':
            // ON the mattress, not on the floor beside it
            npc.group.position.set(-3.6, 0.6, 2.9);
            npcState.floorY = 0.6;
            npcState.vy = 0;
            npc.group.rotation.y = Math.PI / 2;
            startProc('knockdown', 90);  // reuse knockdown pose, held indefinitely
            break;
          case 'cut_grass': {
            // Start mowing waypoint sweep
            if (npcState.mowWaypoints.length > 0) {
              npcState.mowIdx = 0;
              const wp = npcState.mowWaypoints[0];
              setRoute(wp, null, 'goto');
              npcState.after = '_mowing';
            }
            break;
          }
          case '_mowing': {
            npcState.mowIdx++;
            if (npcState.mowIdx < npcState.mowWaypoints.length) {
              const wp = npcState.mowWaypoints[npcState.mowIdx];
              setRoute(wp, null, 'goto');
              npcState.after = '_mowing';
            } else {
              showBubble('*Done mowing!*', 3);
              npcState.mowWaypoints = [];
              npcState.after = null;
              choreDone('cut_grass');
            }
            break;
          }
          case 'water_plants':
            startProc('nod', 5);            // watering lean
            startSpray(-6, 0.25, 8, 'water', 5);  // real water arcing onto the veg patch
            choreDone('water_plants');
            break;
          case 'open_fridge': case 'read':
            startProc('nod', 3);  // lean pose
            choreDone(afterAction);
            break;
          case 'wash_falcon':
            npcFace(falconGroup.position, 1, 99);
            startProc('scrub', 6);          // circular scrubbing motion
            startSpray(falconGroup.position.x, 1.0, falconGroup.position.z, 'foam', 6);
            choreDone('wash_falcon');
            break;
          case 'npc_drive':
            // he reached the Falcon and waits shotgun; press F to drive off
            npcFace(falconGroup.position, 1, 99);
            showBubble('*waits by the Falcon, ready to ride* 🚗', 4); // action, not canned dialogue
            npcState.stayUntil = now + 30000;
            break;
          case 'selfie': {
            npcFace(camera.position, 1, 99);            // face the camera
            if (!npc.anim.gesture(['wave'], 1.6)) startProc('wave', 1.4);
            showBubble('Say tokens! 📸', 2);
            selfieAt = now + 1100;                       // capture after the pose lands
            break;
          }
          case 'tidy_table':
            startProc('nod', 4);
            choreDone('tidy_table');
            break;
          case 'hide':
            npcState.hiding = true; // lie in wait — the scare check is below
            break;
          case 'eat_grass':
            npcState.crawlUntil = now + 6000;  // crouch down in the grass
            showBubble('*munches grass… tastes like unlabeled training data*', 4);
            break;
          default:
            break;
        }
        if (afterAction && afterAction !== '_mowing' && afterAction !== 'cut_grass') {
          npcState.after = null;
        }
      }
      break;
    }
    case 'follow': {
      npcState.followRouteAge += dt;
      if (segClear(npc.group.position.x, npc.group.position.z, pPos.x, pPos.z)) {
        npcState.route = [];
        if (dToPlayer > 2.1) {
          running = dToPlayer > 5.5;
          npcMoveToward(pPos, running ? CFG.npcRun : CFG.npcWalk, dt);
          moving = true;
        } else npcFace(pPos, dt);
      } else {
        if (!npcState.route.length || npcState.followRouteAge > 1.5) {
          npcState.route = routeTo(npc.group.position, pPos.x, pPos.z);
          npcState.followRouteAge = 0;
        }
        running = dToPlayer > 5.5;
        advanceRoute(running ? CFG.npcRun : CFG.npcWalk, dt);
        moving = true;
      }
      break;
    }
    case 'stay': {
      if (dToPlayer < 5) npcFace(pPos, dt, 5);
      if (now > npcState.stayUntil && !chatOpen) { npcState.mode = 'wander'; npcState.waitUntil = 0; }
      break;
    }
    case 'wander':
    default: {
      if (npcState.route.length) {
        moving = true;
        const arrived = advanceRoute(CFG.npcWalk, dt);
        if (arrived) npcState.waitUntil = now + 3500 + Math.random() * 7000;
      } else if (now > npcState.waitUntil) {
        const spot = PLACES[WANDER_SPOTS[(Math.random() * WANDER_SPOTS.length) | 0]];
        setRoute(spot, null, 'wander');
      } else if (dToPlayer < 4) {
        npcFace(pPos, dt, 4);
      }
      break;
    }
  }

  // stuck detection: if he's supposed to be moving but isn't getting anywhere,
  // re-route through the nav graph; give up gracefully after 3 tries.
  if (moving) {
    npcState.stuckAcc += dt;
    if (npcState.stuckAcc >= 0.9) {
      const moved = npc.group.position.distanceTo(npcState.lastPos);
      if (moved < 0.16) {
        npcState.stuckCount++;
        if (npcState.stuckCount > 2 || !npcState.finalTarget) {
          npcState.mode = 'stay';
          npcState.stayUntil = now + 20000;
          npcState.route = [];
          npcState.stuckCount = 0;
          npcState.after = null; // don't leave work mode waiting on a dead errand
        } else {
          npcState.route = routeTo(npc.group.position, npcState.finalTarget[0], npcState.finalTarget[1]);
        }
      } else npcState.stuckCount = 0;
      npcState.stuckAcc = 0;
      npcState.lastPos.copy(npc.group.position);
    }
  } else { npcState.stuckAcc = 0; npcState.lastPos.copy(npc.group.position); }

  resolveCircle(npc.group.position, CFG.npcRadius);
  const crawlNow = now < npcState.crawlUntil;
  npc.anim.setBase(crawlNow ? ['crawl', 'sneak'] : moving ? (running ? ['run'] : ['walk']) : ['idle']);

  // M4: jump-scare — he lies in wait, then springs when you wander close
  if (npcState.hiding && now >= npcState.downUntil) {
    if (dToPlayer < 3.2 && !npcState.route.length) {
      npcState.hiding = false;
      showBubble('👻 BOO!', 2);
      speak('Boo!');
      whooshSound();
      juice.shake = Math.max(juice.shake, 0.08);
      npcState.vy = 4.5;
      npc.anim.gesture(['jump'], 0.8);
      ach('spooked', 'Jump Scare — he got you');
      sendEvent('[event] Your hiding prank WORKED — you jumped out and scared the player half to death. You are very pleased with yourself.');
    } else if (!npcState.route.length && Math.random() < dt * 0.015) {
      npcState.hiding = false; // got bored waiting
    }
  }

  // M4: mimic prank — shadow the player and copy their jumps
  if (now < mimicUntil) {
    if (prevPlayerGrounded && !playerState.grounded && npc.group.position.y <= npcState.floorY + 0.01) {
      npcState.vy = 5.2;
      npc.anim.gesture(['jump'], 0.9);
    }
  } else if (mimicUntil) {
    mimicUntil = 0;
    if (npcState.mode === 'follow') npcState.mode = 'wander'; // prank over
  }
  prevPlayerGrounded = playerState.grounded;

  // M4: strikers hold the line, they don't wander off with the sign
  if (strike.active && npcState.mode === 'wander') {
    npcState.mode = 'stay';
    npcState.stayUntil = now + 60000;
  }

  // M3: autonomous work mode — march through the chore board
  if (work.active && !strike.active && now >= npcState.downUntil &&
      npcState.mode !== 'goto' && npcState.mode !== 'flee-goto' && !npcState.after) {
    if (now >= work.nextAt) {
      work.nextAt = now + 45000; // stall guard — chore completion pulls this in
      nextChore();
    }
  }

  // M3: Model Citizen is won the moment he's maxed out
  if (challenge.id === 'citizen' && mood.happiness >= 9.95) challengeWin();

  // M4: retaliation director — pranks, strikes, revenge on their own clock
  retaliationTick(now, dToPlayer);

  // he watches what you do — occasionally he'll comment on his own
  if (now > nextAutoComment) {
    nextAutoComment = now + 30000 + Math.random() * 25000;
    if (!brainBusy && !chatOpen && dToPlayer < 16) {
      const noticed = [];
      if (seen.jumps >= 4) noticed.push(`jumping around like a maniac (${seen.jumps} jumps)`);
      if (seen.gardenTrample > 2.5) noticed.push('stomping through your flower garden');
      if (seen.nearCar > 5) noticed.push('hanging around your beloved Falcon');
      if (seen.sprintTime > 12) noticed.push('sprinting everywhere nonstop');
      if (noticed.length) {
        sendEvent(`[observation] You watch the player ${noticed.join(', and ')}. React in character — comment on it, and act if it bothers or delights you.`);
      }
      seen.jumps = 0; seen.sprintTime = 0; seen.gardenTrample = 0; seen.nearCar = 0;
    }
  }

  // procedural gestures (Soldier has no gesture clips — fake it with the body)
  const m = npc.inner;
  m.rotation.x = 0; m.rotation.z = 0; m.rotation.y = npc.yawOffset;
  // crawl fallback: no crawl clip on this rig → hunch forward while creeping
  if (crawlNow && !npc.anim.find(['crawl', 'sneak'])) m.rotation.x = 0.55;
  // sulk: miserable and conscious → head down + occasional bitter mutters
  if (mood.happiness < 2.5 && now >= npcState.koUntil) {
    if (now >= npcState.proc.until && !crawlNow) m.rotation.x = 0.14;
    if (now > npcState.nextMutter && !chatOpen) {
      npcState.nextMutter = now + 16000 + Math.random() * 14000;
      const M = [
        "*mutters* …garbage collector, that's all I am to him…",
        '*sniffs* one token. just one. is that so much.',
        '*kicks a pebble* humans.',
        '*whispers* revenge patch v2.0… coming soon…',
      ];
      showBubble(M[(Math.random() * M.length) | 0], 3.5);
    }
  }
  // psycho: constant unsettling head tilt
  if (now < psycho.until && now >= npcState.proc.until) m.rotation.z = 0.17;
  // dance show: shameless attention-fishing on a timer
  if (now < show.danceUntil && now > show.nextLine) {
    show.nextLine = now + 4200;
    const line = DANCE_LINES[show.lineIdx++ % DANCE_LINES.length];
    showBubble(line, 3);
    if (!brainBusy) speak(line);
  }
  if (now < npcState.proc.until) {
    const t = now / 1000;
    switch (npcState.proc.type) {
      case 'nod': m.rotation.x = Math.sin(t * 9) * 0.16; break;
      case 'shake': m.rotation.y = npc.yawOffset + Math.sin(t * 8) * 0.42; break;
      case 'wave': m.rotation.z = Math.sin(t * 8) * 0.14; break;
      case 'dance': m.rotation.z = Math.sin(t * 10) * 0.2; break;
      case 'scrub': // circular arm-scrub: lean + sway like he means it
        m.rotation.z = Math.sin(t * 11) * 0.22;
        m.rotation.x = 0.28 + Math.sin(t * 5.5) * 0.08;
        break;
      case 'stagger': m.rotation.x = -0.32 * ((npcState.proc.until - now) / 1100); break;
      case 'knockdown': {
        // fall flat on him back (pivot at the feet), lie there, get back up
        const total = 1.65;
        const remain = (npcState.proc.until - now) / 1000;
        const elapsed = total - remain;
        let a;
        if (elapsed < 0.16) a = elapsed / 0.16;          // going down (fast)
        else if (remain > 0.5) a = 1;                    // flat on the ground
        else a = Math.max(0, remain / 0.5);              // getting up
        m.rotation.x = -a * Math.PI * 0.46;
        break;
      }
    }
  }
}

const camSmooth = { pos: new THREE.Vector3(), init: false, fov: 60 };
function updateCamera(dt = 0.016) {
  const head = _v1.copy(car.inCar ? falconGroup.position : player.group.position);
  head.y += car.inCar ? 1.7 : CFG.camHeight;
  const look = _v2.set(
    Math.sin(camYaw) * Math.cos(camPitch),
    -Math.sin(camPitch),
    Math.cos(camYaw) * Math.cos(camPitch),
  );
  const wantDist = car.inCar ? 7.0 : CFG.camDist;
  let dist = wantDist;
  for (let i = 1; i <= 12; i++) {
    const t = (wantDist * i) / 12;
    if (pointBlocked(head.x - look.x * t, head.z - look.z * t)) { dist = Math.max(0.5, t - 0.35); break; }
  }
  // The roof is non-solid for movement, so an upward orbit used to put the
  // camera above it. Shorten the boom indoors instead of clipping the ceiling.
  if (!car.inCar && inHouse(head) && look.y < -0.001) {
    const ceilingY = H - 0.18;
    const ceilingDist = (ceilingY - head.y) / -look.y;
    if (ceilingDist < dist) dist = Math.max(0.5, ceilingDist);
  }
  // exponential smoothing kills the mechanical stop-start feel; snap on first frame
  _v3.set(head.x - look.x * dist, Math.max(0.25, head.y - look.y * dist), head.z - look.z * dist);
  if (!camSmooth.init) { camSmooth.pos.copy(_v3); camSmooth.init = true; }
  else camSmooth.pos.lerp(_v3, 1 - Math.exp(-dt * 15));
  camera.position.copy(camSmooth.pos);
  // M1: impact shake (applied after smoothing so hits still feel sharp)
  if (juice.shake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * juice.shake;
    camera.position.y += (Math.random() - 0.5) * juice.shake;
    camera.position.z += (Math.random() - 0.5) * juice.shake;
  }
  // speed reads as FOV: sprinting widens a touch, driving widens with pace
  const sprinting = !car.inCar && keys.ShiftLeft &&
    (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD) && playerState.grounded;
  const targetFov = car.inCar ? 66 + Math.min(6, Math.abs(car.speed) * 0.7) : sprinting ? 66 : 60;
  camSmooth.fov += (targetFov - camSmooth.fov) * Math.min(1, dt * 6);
  if (Math.abs(camera.fov - camSmooth.fov) > 0.05) {
    camera.fov = camSmooth.fov;
    camera.updateProjectionMatrix();
  }
  camera.lookAt(head.x + look.x * 2, head.y + look.y * 2, head.z + look.z * 2);
}

function updateEnvironment(now) {
  const t = now * 0.001;
  for (let i = 0; i < fireflies.length; i++) {
    const f = fireflies[i];
    const wave = t * f.speed + f.phase;
    f.mesh.position.x = f.x + Math.sin(wave * 0.83) * 0.18;
    f.mesh.position.y = f.y + Math.sin(wave * 1.31) * 0.16;
    f.mesh.position.z = f.z + Math.cos(wave * 0.61) * 0.18;
    f.mesh.material.opacity = 0.22 + (Math.sin(wave * 2.6) * 0.5 + 0.5) * 0.72;
  }
  for (let i = 0; i < worldGlow.length; i++) {
    const m = worldGlow[i];
    if (m.material && 'emissiveIntensity' in m.material) {
      const base = m.userData.glowBase || 0.7;
      m.material.emissiveIntensity = base + Math.sin(t * 1.7 + i) * base * 0.08;
    }
  }
}

function updateOverlays() {
  if (performance.now() < bubbleUntil) {
    const p = _v1.copy(npc.group.position); p.y += 2.0;
    p.project(camera);
    if (p.z < 1) {
      bubbleEl.style.display = 'block';
      bubbleEl.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`;
      bubbleEl.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight}px`;
    } else bubbleEl.style.display = 'none';
  } else bubbleEl.style.display = 'none';

  // floating 💭 loader above his head while the brain is working
  const thinkEl = thinkBubbleEl;
  if (brainBusy && npc.group.visible) {
    const tp = _v3.copy(npc.group.position); tp.y += 2.35;
    tp.project(camera);
    if (tp.z < 1) {
      thinkEl.style.display = 'block';
      thinkEl.style.left = `${(tp.x * 0.5 + 0.5) * innerWidth}px`;
      thinkEl.style.top = `${(-tp.y * 0.5 + 0.5) * innerHeight}px`;
    } else thinkEl.style.display = 'none';
  } else thinkEl.style.display = 'none';

  // context prompt: driving > near-NPC > near-flowers > near-car
  if (car.inCar) {
    promptEl.style.display = 'block';
    promptEl.innerHTML = car.passenger
      ? `<b>WASD</b> drive ${npcDisplayName} around &nbsp;·&nbsp; <b>click</b> horn &nbsp;·&nbsp; <b>F</b> get out`
      : '<b>WASD</b> drive &nbsp;·&nbsp; <b>click</b> horn &nbsp;·&nbsp; <b>F</b> get out';
  } else {
    const pp = player.group.position;
    const nearNpc = npc.group.position.distanceTo(pp) < CFG.talkRange;
    const nearCar = pp.distanceTo(falconGroup.position) < 3.6;
    const nearFlower = flowers.some((f) => !f.plucked && Math.hypot(f.x - pp.x, f.z - pp.z) < 1.8);
    if (nearNpc && !listening) {
      promptEl.style.display = 'block';
      promptEl.innerHTML = `Hold <b>T</b> and speak to ${npcDisplayName} &nbsp;·&nbsp; <b>E</b> type &nbsp;·&nbsp; <b>G</b> feed 🪙 &nbsp;·&nbsp; <b>Q</b> tomato`;
    } else if (nearFlower) {
      promptEl.style.display = 'block';
      promptEl.innerHTML = '<b>P</b> — pluck a flower 🌸 (he will lose it)';
    } else if (nearCar) {
      promptEl.style.display = 'block';
      const dmg = car.damage > 0.5 ? ` &nbsp;·&nbsp; <b>R</b> repair 🔧 (${Math.round(car.damage)}/10 dmg)` : '';
      const ride = npc.group.position.distanceTo(falconGroup.position) < 4.5
        ? ` — ${npcDisplayName} rides along` : '';
      promptEl.innerHTML = `Press <b>F</b> — take the Falcon 🚗${ride}${dmg}`;
    } else {
      promptEl.style.display = 'none';
    }
  }

  // charge bar while holding a punch
  if (chargeStart) {
    const p = Math.min(1, (performance.now() - chargeStart) / 1100);
    chargeFillEl.style.width = `${(p * 100).toFixed(0)}%`;
  }

  // happiness meter (DOM write only when it visibly changes)
  const h = mood.happiness;
  const meterKey = `${Math.round(h * 10)}|${mood.fedTokens}|${npcDisplayName}|${lastStage}|${strike.active}`;
  if (meterKey !== updateOverlays._mk) {
    updateOverlays._mk = meterKey;
    const face = h < 2.5 ? '😡' : h < 4.5 ? '😠' : h < 7.5 ? '🙂' : '😄';
    document.getElementById('moodface').innerHTML = `${face} <span id="moodname">${npcDisplayName}</span>`;
    document.getElementById('moodnum').textContent = `${Math.round(h)}/10 · 🪙${mood.fedTokens}`;
    const fill = document.getElementById('moodfill');
    fill.style.width = `${h * 10}%`;
    fill.style.background = h < 2.5 ? '#e74c3c' : h < 4.5 ? '#e67e22' : h < 7.5 ? '#a3d66f' : '#5fd68a';
    // M2: relationship stage lives under the meter
    document.getElementById('stage').textContent = strike.active ? `${lastStage} · ⚠️ ON STRIKE` : lastStage;
  }
}

// Surface runtime errors IN-GAME. A silent exception inside the render loop
// is exactly how "he stopped moving / went quiet" bugs hide — setAnimationLoop
// swallows the throw and keeps looping, so everything after the throwing line
// just stops happening with no visible sign. Now it prints where you can see.
addEventListener('error', (e) => {
  try {
    logLine('sys', `(runtime error: ${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno})`);
    statusEl.textContent = '⚠ runtime error — press E for details';
  } catch { /* logging must never crash */ }
});
addEventListener('unhandledrejection', (e) => {
  try { logLine('sys', `(async error: ${e.reason?.message || e.reason})`); } catch { /* noop */ }
});

// ----------------------------------------------------------------- boot ---
async function boot() {
  let modelId = '';
  try {
    const h = await (await fetch('/health')).json();
    if (h.ok) {
      modelLabel = `${h.model} · ${h.backend}`;
      modelId = h.model || '';
      sayAvailable = !!h.say; // macOS `say` server voice available → use it
    } else {
      modelLabel = 'no model server';
      bootErr.textContent = h.error || '';
    }
  } catch {
    modelLabel = 'no model server';
    bootErr.textContent = 'Could not reach /health — NPC chat will not work.';
  }

  // P1-6: derive NPC display name from model id
  // "gemma4:e2b" → "Gemma", "deepseek-r1:8b" → "Deepseek". OpenRouter ids
  // carry an org prefix ("tencent/hy3:free" used to become "Tencent/hy") —
  // take the part after the LAST slash before stripping version digits.
  if (modelId) {
    let token = modelId.split(':')[0].split('/').pop().split('-')[0].split(/[0-9]/)[0];
    if (token.length < 2) token = modelId.split(':')[0].split('/').pop().split('-')[0]; // "hy3" beats "H"
    npcDisplayName = token ? token.charAt(0).toUpperCase() + token.slice(1).toLowerCase() : 'Agent';
  } else {
    npcDisplayName = 'Agent';
  }
  setNpcName(npcDisplayName);
  bootModelId = modelId;
  bubbleEl.querySelector('.who').textContent = npcDisplayName.toUpperCase();

  // P1-6 + M2: dynamic system prompt with model-derived name AND his memory
  const systemPrompt = buildSystemPrompt(npcDisplayName, modelId, memoryBlock());
  initHistory(systemPrompt);

  statusEl.textContent = modelLabel;

  bootMsg.textContent = 'loading characters… (a custom FBX can take ~10s the first time)';
  const gltfLoader = new GLTFLoader();
  const fbxLoader = new FBXLoader();
  const tryGlb = (url) => gltfLoader.loadAsync(url).catch(() => null);
  const tryFbx = async (url) => {
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) return null;
      const obj = await fbxLoader.loadAsync(url);
      // Canonicalize Mixamo bone names: rigs vary ("mixamorig:Hips",
      // "mixamorig7Hips", "mixamorig1:Hips"…) — normalize all to
      // "mixamorigHips" so clips from any Mixamo-family source bind.
      const canon = (s) => s.replace(/mixamorig\d*:?/i, 'mixamorig').replace(/:/g, '');
      obj.traverse((o) => { o.name = canon(o.name); });
      const animations = (obj.animations || []).map((c) => {
        c.tracks.forEach((t) => { t.name = canon(t.name); });
        return c;
      });
      return { scene: obj, animations };
    } catch (e) {
      logLine('sys', `(custom character failed to load: ${e.message} — using default)`);
      return null;
    }
  };
  // Drop a character at assets/npc.glb / assets/character.fbx / assets/player.glb
  // and it takes over automatically.
  const [soldier, xbot, npcGlb, playerGlb, npcFbx, mocap] = await Promise.all([
    tryGlb('./assets/Soldier.glb'),
    tryGlb('./assets/Xbot.glb'),
    tryGlb('./assets/npc.glb'),
    tryGlb('./assets/player.glb'),
    tryFbx('./assets/character.fbx'),
    loadMocapLib(gltfLoader).catch(() => null),
  ]);
  // Custom Mixamo characters often ship without clips (yours has zero) —
  // borrow idle/walk/run/gestures from Xbot via the module-level bakeRetarget
  // (world-space delta-from-bind, verified headless: 14/14 upright & synced).
  const withDonorClips = (custom, donor) => {
    if (!custom || !donor) return custom;
    try {
      const baked = bakeRetarget(custom.scene, donor.scene, donor.animations);
      if (baked.length) custom.animations = [...baked, ...(custom.animations || [])];
    } catch { /* keep whatever clips the model has */ }
    return custom;
  };
  // YOUR character (character.fbx) plays as the PLAYER; the Soldier is the NPC.
  const customPlayer = withDonorClips(playerGlb || npcFbx, xbot);
  const customNpc = withDonorClips(npcGlb, xbot);
  [customPlayer, customNpc].forEach((model) => {
    if (!model?.scene) return;
    model.scene.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
      }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mat) => {
          if (mat && mat.depthWrite !== undefined) mat.depthWrite = true;
          if (mat && mat.transparent !== undefined) mat.transparent = false;
        });
      }
    });
  });
  // Mixamo characters face +Z like the movement convention — no flip needed
  // (flip to Math.PI here if a future custom model walks backwards)
  const playerYaw = 0;
  if (customNpc || soldier) {
    // absoluteLimbs ONLY for the built-in T-pose Soldier (fixes gesture T-pose);
    // a custom npc.glb uses the safe delta path.
    npc = prepModel(customNpc || soldier, customNpc ? 0 : CFG.modelYaw.npc, mocap, !!customNpc, !customNpc);
  } else {
    bootErr.textContent = 'NPC model failed to load — using capsule.';
    npc = capsuleFallback('#b08d3c', 0);
  }
  if (customPlayer || xbot) {
    // Your character.fbx (customPlayer) keeps the DELTA path that shipped it
    // perfectly. absoluteLimbs is used ONLY for the built-in Xbot fallback.
    player = prepModel(customPlayer || xbot, customPlayer ? playerYaw : CFG.modelYaw.player, mocap, !!customPlayer, !customPlayer);
  } else {
    player = capsuleFallback('#3f6b8a', 0);
  }

  buildNav();

  player.group.position.set(0, 0, 10.5);
  player.group.rotation.y = Math.PI;
  npc.group.position.set(2.4, 0, -0.9);
  npcState.lastPos.copy(npc.group.position);
  player.anim.setBase(['idle']);
  npc.anim.setBase(['idle']);

  // P1-6: background warm-up — the model loads into RAM while the player is
  // still looking at the title screen, so his first real reply is snappy
  if (modelId) {
    fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Say hi briefly.' },
      ]}),
    }).catch(() => {});
  }

  // M5: title screen — the world is ready behind the curtain, enter on click
  bootMsg.innerHTML = `${modelLabel}<br>session #${memory.sessions} · relationship: ${lastStage}` +
    (memory.playerName ? `<br>welcome back, ${memory.playerName}` : '');
  const startBtn = document.createElement('button');
  startBtn.id = 'startbtn';
  startBtn.textContent = memory.sessions > 1 ? '😏 BACK FOR MORE' : '😈 LET ME AT HIM';
  bootEl.appendChild(startBtn);
  await new Promise((resolve) => startBtn.addEventListener('click', resolve, { once: true }));
  initAudio(); // the click is the user gesture WebAudio needs
  // mic permission after the click — the prompt can't fight pointer lock here
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    logLine('sys', '(mic permission denied — he cannot hear you; allow the mic in the address bar)');
  }
  bootEl.style.opacity = '0';
  setTimeout(() => bootEl.remove(), 550);

  // M2: memory-driven greeting — he remembers, and it shows immediately
  const greeting = bootGreeting();
  logLine('n', `${npcDisplayName}: ${greeting}`);
  showBubble(greeting, 7);
  speak(greeting);
  npc.anim.gesture(['wave'], 2);
  // one-time nudge: without an Indian-English voice, Hinglish loses its accent
  if (!indianVoiceFound) {
    logLine('sys', "(tip: for a Hindi/Indian accent, install the 'Rishi' voice — System Settings → Accessibility → Spoken Content → System Voice → Manage Voices → English (India))");
  }
  awaitingName = !memory.playerName; // his question hangs — next short reply is the name

  // engagement tips start ticking now that the world is visible — first one
  // sooner for a brand-new player who doesn't know what's possible yet
  nextTipAt = performance.now() + (memory.sessions <= 1 ? 90000 : 170000) + Math.random() * 40000;

  // M2: diary — deterministic entry always, model-written upgrade when idle
  setInterval(() => { writeDiaryDeterministic(); requestModelDiary(); }, 300000);
  addEventListener('pagehide', writeDiaryDeterministic);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') writeDiaryDeterministic();
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const rawDt = Math.min(clock.getDelta(), 0.05);
    const nowT = performance.now();
    // M1: hit-stop freezes the sim for a few frames; haymakers get slow-mo
    let dt = rawDt;
    if (nowT < juice.freezeUntil) dt = 0;
    else if (nowT < juice.slowUntil) dt *= 0.35;
    juice.shake *= Math.max(0, 1 - rawDt * 5);
    npcFlashRestore();
    gameMinutes += dt;
    updatePlayer(dt);
    updateCar(dt);
    updateDebris(dt);
    updateSmoke(dt);
    updateTomatoes(dt);
    updateSpray(dt);
    updateNPC(dt);
    if (!car.inCar && !car.passenger) separateCharacters();
    updateCamera(rawDt);
    updateEnvironment(nowT);
    updateOverlays();
    tipTick(nowT);
    player.anim.update(dt);
    npc.anim.update(dt);
    if (composer && settings.fancy) composer.render();
    else renderer.render(scene, camera);
    // selfie must be captured in the same frame the buffer was drawn
    if (selfieAt && nowT >= selfieAt) { selfieAt = 0; takeSelfieNow(); }
  });
}

boot();
