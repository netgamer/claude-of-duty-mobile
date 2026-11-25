import { Engine } from './core/engine.js';
import { createConfig } from './core/config.js';
import { detectPlatform } from './core/platform.js';
import { TouchControls } from './core/touch.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';

// Phones get their own input path, resolution cap and default preset; the
// desktop path is untouched. `?touch=0` opts out, `?touch=1` opts in (that is
// how the mobile smoke test and desktop browser devtools QA both work).
const platform = detectPlatform(location.search);

const config = createConfig({
  quality: params.get('q') ?? platform.quality,
  deterministic: capture,
  platform,
});
if (platform.touch) document.documentElement.classList.add('ow-touch-mode');
// `?adaptive=0` pins the render resolution: the smoke test and any pixel
// comparison need one fixed size, and a phone user debugging a thermal issue
// gets a way to turn the governor off.
if (params.get('adaptive') === '0') config.q.adaptive = false;
window.__PLATFORM__ = platform;

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem);

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// ---- on-screen controls -------------------------------------------------
// Built after every subsystem has initialised (it needs `ctx.input`), and before
// the loop starts. On a phone it opens with a deploy gate and the simulation
// held at t=0: nothing should be shooting while the player is still looking at
// a loading panel, and the first tap is what unlocks Web Audio.
const touch = platform.touch
  ? new TouchControls(engine.ctx, platform, { gate: params.get('gate') !== '0' })
  : null;
engine.ctx.touch = touch;

// ---- headless simulation ------------------------------------------------
// `?render=0` keeps the whole engine running — input, player, weapons, AI,
// physics, HUD — but skips the draw call. Automated tests use it to exercise
// gameplay and UI wiring on a machine with no usable GPU, where a single
// firefight's worth of software-rendered frames can make the browser drop the
// WebGL context. Pixels are not part of those tests; `?render=1` (the default)
// is the real game.
if (params.get('render') === '0') {
  const r = engine.registry.peek('render');
  if (r) r.render = () => {};
  console.info('[boot] render=0 — simulation without drawing');
}

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
const warmup =
  params.get('prewarm') === '0' || params.get('render') === '0'
    ? { ok: false, reason: 'skipped' }
    : await prewarm(engine);
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

engine.start();

// Boot gate out of the way: the level exists and the loop is running.
const bootGate = document.getElementById('ow-boot');
if (bootGate) {
  bootGate.classList.add('gone');
  setTimeout(() => bootGate.remove(), 700);
}

// ---- WebGL context loss -------------------------------------------------
// The one mobile failure that is unrecoverable in place: once the GPU drops the
// context, every buffer is gone and a silent black screen follows. Prevent the
// default (which would suppress the restore event), freeze the loop, and tell
// the player to reload instead of leaving them staring at a dead canvas.
function showContextLost(banner) {
  let el = document.getElementById('ow-context-lost');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ow-context-lost';
    el.style.cssText =
      'position:fixed;inset:0;z-index:99999;display:grid;place-items:center;text-align:center;' +
      'background:rgba(3,5,7,.92);color:#eef4f7;font:600 13px/1.9 "Avenir Next Condensed",' +
      'system-ui,sans-serif;letter-spacing:.18em;text-transform:uppercase;padding:24px';
    el.innerHTML =
      `<div><div style="font-size:22px;letter-spacing:.3em">${banner}</div>` +
      '<div style="margin-top:14px;color:rgba(214,227,234,.6);font-size:11px">' +
      'The GPU dropped this session. Reload to continue.</div>' +
      '<button id="ow-reload" style="margin-top:22px;padding:12px 26px;border:1px solid #ffb02a;' +
      'background:none;color:#ffd08a;font:inherit;letter-spacing:.3em;cursor:pointer">RELOAD</button></div>';
    document.body.appendChild(el);
    el.querySelector('#ow-reload').addEventListener('click', () => location.reload());
  }
}

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  console.error('[render] WebGL context lost');
  engine.stop();
  touch?.setEnabled(false);
  showContextLost('Graphics context lost');
});
canvas.addEventListener('webglcontextrestored', () => {
  console.info('[render] WebGL context restored — reloading');
  location.reload();
});

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const readyProbe = () => {
    if (++warm >= BOOT_FRAMES) {
      window.__READY__ = true;
      return;
    }
    requestAnimationFrame(readyProbe);
  };
  requestAnimationFrame(readyProbe);
}

window.__ENGINE__ = engine;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
