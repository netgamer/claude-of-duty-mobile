#!/usr/bin/env node
/**
 * MOBILE SMOKE TEST — boots the built bundle in a touch-emulating Chromium and
 * drives it the way a thumb would.
 *
 * What it proves, in order:
 *   1. the page reports itself as a touch device; the on-screen controls exist
 *   2. the deploy gate holds the simulation at t=0, and the first tap releases
 *      it and unlocks Web Audio
 *   3. the joystick moves the player, and full deflection sprints
 *   4. the look area turns the camera; FIRE shoots and aims while held
 *   5. ADS toggles; reload / jump / crouch reach their subsystems
 *   6. the pause button opens the menu and Resume closes it
 *   7. the quality preset can be switched at runtime
 *   8. portrait re-lays out the HUD and the controls stay on screen
 *   9. zero uncaught page errors and zero console errors
 *
 * Usage:
 *   npm run build && node tools/mobile-test.mjs
 *   node tools/mobile-test.mjs --phase=input            # controls only
 *   node tools/mobile-test.mjs --phase=ui               # menu/quality/orientation
 *   node tools/mobile-test.mjs --w=390 --h=844          # portrait
 *   node tools/mobile-test.mjs --dpr=3 --only=boot      # DPR ceiling
 *   node tools/mobile-test.mjs --real-touch             # drive via CDP touch
 *
 * Notes for whoever runs this on a machine without a GPU:
 *   The harness renders WebGL in software. That is enough to compile every
 *   shader and to render real frames, but a burst of new GPU work (the first
 *   shot of a firefight, a long shader compile) can make Chromium drop the
 *   context, which the game correctly answers by reloading. `--deadline`
 *   (default 240 s) keeps a run inside one invocation and reports what it got.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const TARGET = args.target ?? 'dist';
const PORT = Number(args.port ?? (TARGET === 'dev' ? 5173 : 4173));
const SHOTS = resolve(args.out ?? 'shots/mobile');
// `--norender` runs the engine without drawing (see `?render=0` in main.js):
// on a machine with no usable GPU this is what makes the interaction phases
// reliable and fast. Anything that inspects pixels must not use it.
const EXTRA = `${args.norender ? '&render=0' : ''}${args.query ? `&${args.query}` : ''}`;
const TIMEOUT = Number(args.timeout ?? 200000);
const DEADLINE = Number(args.deadline ?? 240) * 1000;
const DPR = Number(args.dpr ?? 1);
const PHASE = typeof args.phase === 'string' ? args.phase : 'all';
const RUN_INPUT = PHASE === 'all' || PHASE === 'input';
const RUN_FIRE = PHASE === 'all' || PHASE === 'fire';
const RUN_UI = PHASE === 'all' || PHASE === 'ui';
const RUN_QUALITY = PHASE === 'all' || PHASE === 'quality';
const RUN_LAYOUT = PHASE === 'all' || PHASE === 'layout';
const RUN_PORTRAIT = PHASE === 'all' || PHASE === 'portrait';
const ONLY = typeof args.only === 'string' ? args.only : null;
// A `?render=0` page has nothing to photograph.
const WANT_SHOTS = args.shots !== '0' && ONLY !== 'boot' && !args.norender;
const REAL_TOUCH = args['real-touch'] === true;
// Desktop regression pass: the same harness with a mouse/keyboard context, to
// prove the mobile work did not change the desktop game.
const DESKTOP = args.desktop === true;

// A landscape phone. `--w/--h` shrink it for the interaction phase: this harness
// renders in software, and smaller is the only way to get more frames in.
const W = Number(args.w ?? 844);
const H = Number(args.h ?? 390);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  if (TARGET === 'dist' && !existsSync(resolve(ROOT, 'dist/index.html'))) {
    throw new Error('dist/ is missing — run `npm run build` first');
  }
  // `vite preview` would be a second Node process; this box has ~1 GB of RAM and
  // Chromium's software WebGL wants most of it.
  const p =
    TARGET === 'dev'
      ? spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
          cwd: ROOT,
          stdio: 'ignore',
          env: { ...process.env, OW_NO_HMR: '1' },
        })
      : spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', 'dist'], {
          cwd: ROOT,
          stdio: 'ignore',
        });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    if (await portOpen(PORT)) return p;
  }
  p.kill();
  throw new Error('static server failed to start');
}

/* ------------------------------------------------------------- reporting -- */

const TSTART = Date.now();
const results = [];
let failures = 0;
let aborted = null;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures++;
  const t = `${((Date.now() - TSTART) / 1000).toFixed(0)}s`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.padStart(5)}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

function guard(step) {
  if (Date.now() - TSTART > DEADLINE) {
    const e = new Error(`deadline ${DEADLINE / 1000}s reached at "${step}"`);
    e.isDeadline = true;
    throw e;
  }
}

function summary() {
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (aborted) console.log(`ABORTED: ${aborted}`);
  console.log(`shots: ${SHOTS}`);
  if (errors.length) console.log(`\nconsole errors:\n${errors.slice(0, 8).join('\n')}`);
}

/* ------------------------------------------------------------------ boot -- */

const server = await ensureServer();
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    // Software WebGL2. On a real device this is the device's own driver; what is
    // under test here is the WebGL2 path and every shader, not the frame rate.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    '--no-sandbox',
    '--force-color-profile=srgb',
    '--disable-gpu-watchdog',
  ],
});

const context = await browser.newContext({
  viewport: { width: W, height: H },
  isMobile: !DESKTOP,
  hasTouch: !DESKTOP,
  // A real iPhone is 3x. The default is 1x because a 3x surface triples the
  // software cost; the layout is defined in CSS pixels so nothing under test
  // changes. `--dpr=3 --only=boot` verifies the DPR ceiling itself.
  deviceScaleFactor: DPR,
  userAgent: DESKTOP
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const errors = [];
const logs = [];
page.on('console', (m) => {
  const text = m.text();
  logs.push(`[${m.type()}] ${text}`);
  if (m.type() === 'error') errors.push(text);
  if (/context lost|context restored/i.test(text)) console.log(`      !! ${text}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('crash', () => console.log('      !! page crashed'));
page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) console.log(`      !! navigated ${((Date.now() - TSTART) / 1000).toFixed(0)}s`);
});

/* ------------------------------------------------------------ touch pump -- */

// Two ways to drive the on-screen controls.
//
// `--real-touch` sends genuine touch events through CDP: the truest signal
// (browser delivery, touch-action, pointer synthesis). On this harness's
// software GL the CDP input path drops the WebGL context within a second of the
// first gameplay touch — a browser/environment bug, not a game bug — so the
// default dispatches PointerEvents straight at the page with the same shape the
// browser produces (`pointerType: 'touch'`, one `pointerId` per finger, bubbling
// to the `#ow-touch` root). That is exactly what the controls consume, and
// multi-touch is exercised as the code sees it: several pointerIds down at once.
const liveIds = new Set();
const lastPos = new Map();
let nextId = 100;

async function dispatch(kind, id, x, y) {
  if (REAL_TOUCH) {
    const points = [...liveIds].map((i) => ({
      x: i === id ? x : lastPos.get(i).x,
      y: i === id ? y : lastPos.get(i).y,
      id: i,
      radiusX: 12,
      radiusY: 12,
      force: 1,
    }));
    if (kind === 'pointerdown') {
      liveIds.add(id);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
    } else if (kind === 'pointermove') {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
    } else {
      liveIds.delete(id);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: points.filter((p) => p.id !== id),
      });
    }
    return;
  }
  await page.evaluate(
    ({ kind, id, x, y }) => {
      const root = document.getElementById('ow-touch');
      const target = document.elementFromPoint(x, y) || root;
      target.dispatchEvent(
        new PointerEvent(kind, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: true,
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: kind === 'pointerup' ? -1 : 0,
          buttons: kind === 'pointerup' ? 0 : 1,
          pressure: kind === 'pointerup' ? 0 : 0.5,
        })
      );
    },
    { kind, id, x, y }
  );
}

async function touchStart(points) {
  for (const p of points) {
    const id = p.id ?? ++nextId;
    lastPos.set(id, { x: p.x, y: p.y });
    await dispatch('pointerdown', id, p.x, p.y);
  }
  await sleep(30);
}
async function touchMove(points) {
  for (const p of points) {
    lastPos.set(p.id, { x: p.x, y: p.y });
    await dispatch('pointermove', p.id, p.x, p.y);
  }
  await sleep(30);
}
async function touchEnd() {
  for (const id of [...lastPos.keys()]) {
    const p = lastPos.get(id);
    await dispatch('pointerup', id, p.x, p.y);
    // A tap that lands on a DOM control (the pause menu's buttons) must behave
    // like one: browsers synthesise `click` from a touch, and a synthetic
    // PointerEvent does not.
    if (!REAL_TOUCH) {
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el && !el.closest('#ow-touch')) el.closest('button')?.click();
      }, p);
    }
  }
  lastPos.clear();
  await sleep(30);
}

/* --------------------------------------------------------------- helpers -- */

/** Wait until the engine has advanced `n` rendered frames. */
async function frames(n = 1, timeout = 60000) {
  const start = await page.evaluate('window.__ENGINE__ ? window.__ENGINE__.time.frame : -1');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = await page.evaluate('window.__ENGINE__ ? window.__ENGINE__.time.frame : -1').catch(() => -1);
    if (f < 0) throw new Error('engine gone (page reloaded)');
    if (f >= start + n) return f - start;
    await sleep(100);
  }
  return -1;
}

async function snap() {
  const out = await page.evaluate(() => {
    const e = window.__ENGINE__;
    if (!e) return null;
    const i = e.ctx.input;
    const p = e.ctx.peek('player');
    const w = e.ctx.peek('weapons');
    const ui = e.ctx.peek('ui');
    const r = e.ctx.peek('render');
    return {
      frame: e.time.frame,
      scale: +e.time.scale.toFixed(3),
      stick: { x: +i.stick.moveX.toFixed(3), y: +i.stick.moveY.toFixed(3) },
      touchActive: !!i.touch.active,
      keys: [...i.down].filter(
        (c) => c.startsWith('Mouse') || c === 'ShiftLeft' || c === 'Space' || c === 'ControlLeft'
      ),
      fire: i.fire,
      ads: i.ads,
      pointerLockAllowed: i.pointerLockAllowed,
      player: p
        ? {
            yaw: p.movement ? +p.movement.yaw.toFixed(3) : null,
            stance: p.movement?.stance ?? null,
            pos: p.position ? [+p.position.x.toFixed(2), +(p.position.y ?? 0).toFixed(2), +p.position.z.toFixed(2)] : null,
            airborne: !!p.movement?.airborne,
            ads: p.adsRequested ?? null,
          }
        : null,
      weapon: w?.getHudState ? w.getHudState() : null,
      menuOpen: !!ui?.menu?.open,
      gate: window.__TOUCH__ ? window.__TOUCH__.gateOpen : null,
      render: r
        ? {
            size: [r.screenSize.width, r.screenSize.height],
            display: [r.displaySize.width, r.displaySize.height],
            dpr: r.renderer.getPixelRatio(),
            quality: e.ctx.config.quality,
            dyn: r._dynScale,
          }
        : null,
    };
  });
  return out;
}

async function rect(sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left };
  }, sel);
}

/**
 * Screenshot with the loop halted. Playwright's own capture waits on a
 * compositor frame that never lands while the main thread is inside a
 * multi-hundred-millisecond software draw, so this goes through CDP and falls
 * back to the page API for a real GPU.
 */
async function shot(name) {
  if (!WANT_SHOTS) return null;
  const path = resolve(SHOTS, `${name}.png`);
  const wasRunning = await page.evaluate('!!window.__ENGINE__ && window.__ENGINE__._running').catch(() => false);
  if (wasRunning) await page.evaluate('window.__ENGINE__.stop()').catch(() => {});
  await sleep(150);
  let ok = false;
  try {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(path, Buffer.from(data, 'base64'));
    ok = true;
  } catch (e) {
    try {
      await page.screenshot({ path, type: 'png', timeout: 60000 });
      ok = true;
    } catch (e2) {
      console.log(`      shot FAILED ${name}: ${e2.message.split('\n')[0]}`);
    }
  }
  if (wasRunning) await page.evaluate('window.__ENGINE__.start()').catch(() => {});
  if (ok) console.log(`      shot ${path}`);
  return ok ? path : null;
}

/* ------------------------------------------------------------------ run --- */

async function main() {
  const url = `http://127.0.0.1:${PORT}/?prewarm=${args.prewarm ?? 0}${EXTRA}`;
  console.log(`\n=== mobile smoke test · ${TARGET} · ${W}x${H} @${DPR}x · phase:${PHASE} · ${REAL_TOUCH ? 'real' : 'synthetic'} touch`);
  console.log(`    ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  const platform = await page.evaluate('window.__PLATFORM__');
  check('boot: first frame rendered', true, { ms: Date.now() - TSTART });
  if (!DESKTOP) {
    check('platform: touch detected', platform?.touch === true, {
      touch: platform?.touch,
      mobile: platform?.mobile,
      coarse: platform?.coarse,
      dpr: platform?.dpr,
      maxPixelRatio: platform?.maxPixelRatio,
    });
    check('platform: mobile preset by default', platform?.quality === 'mobile', platform?.quality);
  }
  check('platform: DPR ceiling', (platform?.maxPixelRatio ?? 9) <= 1.5, platform?.maxPixelRatio);

  let s = await snap();

  if (DESKTOP) {
    check('desktop: no touch path taken', platform?.touch === false, { touch: platform?.touch, mobile: platform?.mobile });
    check('desktop: no on-screen controls', (await page.evaluate('!!document.querySelector("#ow-touch")')) === false);
    check('desktop: pointer lock allowed', s.pointerLockAllowed === true);
    check('desktop: desktop preset by default', platform?.quality === 'ultra', platform?.quality);
    check('desktop: DPR capped at 1.5', s.render.dpr <= 1.5 + 1e-6, s.render);
    // Keyboard still drives the player, and the mouse still turns the head.
    await page.keyboard.down('KeyW');
    await frames(3);
    const moved = await snap();
    await page.keyboard.up('KeyW');
    check('desktop: WASD moves', moved.player.pos[0] !== s.player.pos[0] || moved.player.pos[2] !== s.player.pos[2], {
      from: s.player.pos,
      to: moved.player.pos,
    });
    await page.mouse.move(W / 2, H / 2);
    await page.mouse.down();
    await page.mouse.up();
    await frames(2);
    check('desktop: mouse click does not break the loop', (await snap()).frame > 0);
    return;
  }

  check('render: DPR capped', s.render.dpr <= (platform?.maxPixelRatio ?? 1.5) + 1e-6, s.render);
  check('render: internal scale is the mobile budget', s.render.size[0] < s.render.display[0], s.render);
  check('input: pointer lock off on touch', s.pointerLockAllowed === false);
  check('gate: simulation held at t=0', s.scale === 0 && s.gate === true, { scale: s.scale, gate: s.gate });
  check('controls: overlay present', (await page.evaluate('!!document.querySelector("#ow-touch")')) === true);
  check(
    'controls: every action present',
    (await page.evaluate(
      '[...document.querySelectorAll("#ow-touch [data-act]")].map(e=>e.dataset.act).sort().join(",")'
    )) === 'ads,crouch,fire,jump,pause,reload'
  );

  if (ONLY === 'boot') return;

  // ---- tap to deploy -----------------------------------------------------
  guard('deploy');
  await touchStart([{ x: W / 2, y: H / 2, id: 901 }]);
  await touchEnd();
  await frames(1);
  s = await snap();
  check('gate: dismissed by first tap', s.gate === false);
  check('gate: simulation released', s.scale === 1, s.scale);
  const audioState = await page.evaluate('window.__AUDIO__ ? window.__AUDIO__.stats : null');
  check('audio: context unlocked by the tap', audioState?.contextState === 'running', audioState?.contextState);

  if (RUN_INPUT) {
    // ---- joystick: forward + sprint ------------------------------------
    guard('stick');
    const before = await snap();
    await touchStart([{ x: 120, y: H - 96, id: 902 }]);
    await touchMove([{ x: 120, y: H - 186, id: 902 }]);
    await frames(3);
    s = await snap();
    check('stick: forward vector', s.stick.y < -0.6, s.stick);
    check('stick: sprint at full deflection', s.keys.includes('ShiftLeft'), s.keys);
    check(
      'stick: player moved forward',
      Math.hypot(s.player.pos[0] - before.player.pos[0], s.player.pos[2] - before.player.pos[2]) > 0.4,
      { from: before.player.pos, to: s.player.pos }
    );
    await touchEnd();
    await frames(2);
    s = await snap();
    check('stick: released on touch end', Math.abs(s.stick.x) < 0.01 && Math.abs(s.stick.y) < 0.01, s.stick);

    // ---- look drag ------------------------------------------------------
    guard('look');
    const yaw0 = (await snap()).player.yaw;
    await touchStart([{ x: 600, y: 220, id: 903 }]);
    for (let i = 1; i <= 6; i++) await touchMove([{ x: 600 - i * 22, y: 220, id: 903 }]);
    await touchEnd();
    await frames(3);
    s = await snap();
    check('look: drag turned the camera', Math.abs(s.player.yaw - yaw0) > 0.08, { from: yaw0, to: s.player.yaw });

  }

  if (RUN_FIRE) {
    // ---- fire button: hold, and aim while holding ----------------------
    guard('fire');
    const fireBtn = await rect('.ow-t-fire');
    check('controls: fire button placed', !!fireBtn && fireBtn.x < W && fireBtn.y < H, fireBtn);
    const ammo0 = (await snap()).weapon?.ammo;
    const yaw1 = (await snap()).player.yaw;
    await touchStart([{ x: fireBtn.x, y: fireBtn.y, id: 904 }]);
    await frames(2);
    check('fire: trigger held', (await snap()).fire === true);
    await touchMove([{ x: fireBtn.x - 40, y: fireBtn.y, id: 904 }]);
    await frames(2);
    s = await snap();
    check('fire: drag aims while firing', Math.abs(s.player.yaw - yaw1) > 0.03, { from: yaw1, to: s.player.yaw });
    await touchEnd();
    await frames(4);
    s = await snap();
    check('fire: rounds spent', typeof ammo0 === 'number' && s.weapon.ammo < ammo0, { before: ammo0, after: s.weapon?.ammo });
    check('fire: released on touch end', s.fire === false);

    // ---- multi-touch: move, aim and shoot at the same time -------------
    guard('multi-touch');
    await touchStart([{ x: 120, y: H - 96, id: 920 }]);
    await touchMove([{ x: 120, y: H - 186, id: 920 }]);
    await touchStart([{ x: fireBtn.x, y: fireBtn.y, id: 921 }]);
    await frames(2);
    s = await snap();
    check('multi-touch: stick and trigger held together', s.stick.y < -0.5 && s.fire === true, {
      stick: s.stick,
      fire: s.fire,
      pointers: (await page.evaluate('window.__TOUCH__.pointers ? window.__TOUCH__.pointers.size : -1')),
    });
    await touchEnd();
    await frames(2);
    s = await snap();
    check('multi-touch: all pointers released', s.fire === false && Math.abs(s.stick.y) < 0.01, s.stick);
    await shot('02-gameplay-landscape');
  }

  if (RUN_UI) {
    // ---- ADS toggle -----------------------------------------------------
    guard('ads');
    const adsBtn = await rect('.ow-t-ads');
    await touchStart([{ x: adsBtn.x, y: adsBtn.y, id: 905 }]);
    await touchEnd();
    await frames(3);
    check('ads: toggled on', (await snap()).ads === true);
    await shot('03-ads');
    await touchStart([{ x: adsBtn.x, y: adsBtn.y, id: 906 }]);
    await touchEnd();
    await frames(3);
    check('ads: toggled off', (await snap()).ads === false);

    // ---- reload / jump / crouch ----------------------------------------
    guard('reload');
    const reloadBtn = await rect('.ow-t-reload');
    // A reload at a full magazine is a no-op in the weapon system, so spend a
    // few rounds first — this is also the path a player takes.
    const fireB = await rect('.ow-t-fire');
    await touchStart([{ x: fireB.x, y: fireB.y, id: 915 }]);
    await frames(2);
    await touchEnd();
    await frames(2);
    const ammoBefore = (await snap()).weapon?.ammo ?? 0;
    await touchStart([{ x: reloadBtn.x, y: reloadBtn.y, id: 907 }]);
    await touchEnd();
    await frames(3);
    s = await snap();
    check('reload: weapon reloading', s.weapon?.reloading === true, {
      reloading: s.weapon?.reloading,
      ammo: s.weapon?.ammo,
      before: ammoBefore,
    });

    guard('jump');
    const jumpBtn = await rect('.ow-t-jump');
    const y0 = (await snap()).player.pos[1];
    await touchStart([{ x: jumpBtn.x, y: jumpBtn.y, id: 908 }]);
    await frames(2);
    s = await snap();
    const yUp = s.player.pos[1] - y0;
    check('jump: player left the ground', s.player.airborne === true || yUp > 0.05 || s.keys.includes('Space'), {
      airborne: s.player.airborne,
      rise: +yUp.toFixed(2),
      keys: s.keys,
    });
    await touchEnd();
    await frames(4);

    guard('crouch');
    const crouchBtn = await rect('.ow-t-crouch');
    await touchStart([{ x: crouchBtn.x, y: crouchBtn.y, id: 909 }]);
    await touchEnd();
    await frames(4);
    check('crouch: stance changed', (await snap()).player.stance !== 'stand', (await snap()).player.stance);
    await touchStart([{ x: crouchBtn.x, y: crouchBtn.y, id: 910 }]);
    await touchEnd();
    await frames(4);

    // ---- pause menu -----------------------------------------------------
    guard('pause');
    const pauseBtn = await rect('.ow-t-pause');
    await touchStart([{ x: pauseBtn.x, y: pauseBtn.y, id: 911 }]);
    await touchEnd();
    await frames(3);
    check('pause: menu opened from the pad', (await snap()).menuOpen === true);
    await shot('04-pause-menu');
    const resume = await rect('.ow-btn.primary');
    check('pause: menu has a resume button on screen', !!resume, resume);
    await touchStart([{ x: resume.x, y: resume.y, id: 912 }]);
    await touchEnd();
    await frames(3);
    check('pause: resumed', (await snap()).menuOpen === false);

  }

  if (RUN_QUALITY) {
    // ---- quality switch -------------------------------------------------
    guard('quality');
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').menu.show());
    await frames(1);
    const labels = await page.evaluate('[...document.querySelectorAll(".ow-seg")[0].querySelectorAll("button")].map(b=>b.textContent).join(",")');
    check('quality: touch offers mobile instead of ultra', labels === 'mobile,low,med,high', labels);
    await page.evaluate(
      () => [...document.querySelectorAll('.ow-seg')[0].querySelectorAll('button')].find((b) => b.textContent === 'low')?.click()
    );
    await frames(3);
    check('quality: switched to low at runtime', (await snap()).render.quality === 'low', (await snap()).render);
    await page.evaluate(
      () => [...document.querySelectorAll('.ow-seg')[0].querySelectorAll('button')].find((b) => b.textContent === 'mobile')?.click()
    );
    await frames(2);
    check('quality: back to mobile', (await snap()).render.quality === 'mobile');
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').menu.close());
    await frames(2);
  }

  if (RUN_LAYOUT) {
    // ---- landscape framing ---------------------------------------------
    guard('landscape');
    await frames(3);
    await shot('02-gameplay-landscape');

    // ---- aiming down sights --------------------------------------------
    guard('ads-shot');
    const adsB = await rect('.ow-t-ads');
    await touchStart([{ x: adsB.x, y: adsB.y, id: 930 }]);
    await touchEnd();
    await frames(4);
    await shot('03-ads');
    await touchStart([{ x: adsB.x, y: adsB.y, id: 931 }]);
    await touchEnd();
    await frames(2);

    // ---- pause menu over the live frame --------------------------------
    guard('menu-shot');
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').menu.show());
    await frames(2);
    await shot('04-pause-menu');
    await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').menu.close());
    await frames(2);

  }

  if (RUN_PORTRAIT) {
    // ---- portrait -------------------------------------------------------
    guard('portrait');
    // Booted already tall (`--w=390 --h=844`) means no rotation is needed; the
    // rotated case is what the full run exercises.
    const portraitNow = W < H;
    if (!portraitNow) {
      await page.setViewportSize({ width: H, height: W });
      await frames(4);
    }
    s = await snap();
    const vw = portraitNow ? W : H;
    const vh = portraitNow ? H : W;
    const fireP = await rect('.ow-t-fire');
    check(
      'portrait: controls stay inside the viewport',
      !!fireP && fireP.x > 0 && fireP.x < vw && fireP.y > 0 && fireP.y < vh,
      fireP
    );
    check(
      'portrait: HUD rebuilt at the new size',
      s.render.display[0] <= vw * (platform?.maxPixelRatio ?? 1) + 1,
      s.render
    );
    await shot('05-gameplay-portrait');
  }

  // ---- frame pacing (informational) -------------------------------------
  const f0 = await page.evaluate('window.__ENGINE__.time.frame');
  await sleep(3000);
  const f1 = await page.evaluate('window.__ENGINE__.time.frame');
  check('perf: frames are advancing', f1 > f0, { frames: f1 - f0, fps: +((f1 - f0) / 3).toFixed(1) });

  check(
    'console: no uncaught errors',
    errors.filter((e) => !/Autoplay|play\(\) failed|AudioContext was not allowed|favicon/i.test(e)).length === 0,
    errors.slice(0, 6)
  );
}

try {
  await main();
} catch (e) {
  aborted = e.isDeadline ? e.message : `${e.message.split('\n')[0]}`;
  if (!e.isDeadline) console.log(`      !! ${aborted}`);
} finally {
  await browser.close().catch(() => {});
  if (server && !args.keep) server.kill();
  summary();
  if (args.verbose) console.log(`\nlogs:\n${logs.slice(-50).join('\n')}`);
  process.exit(failures || aborted ? 1 : 0);
}
