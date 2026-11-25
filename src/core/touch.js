/**
 * TOUCH CONTROLS — the on-screen gamepad for phones and tablets.
 *
 * A DOM overlay that turns raw multi-touch into the same input the desktop
 * build already consumes. Nothing in gameplay changes: the buttons synthesise
 * the very key codes the keyboard uses (`Mouse0` for fire, `Mouse2` for ADS,
 * `KeyR`, `Space`, `ControlLeft`, `Escape`), and the look area feeds the same
 * per-frame delta the mouse does. That is deliberate — `weapons`, `player`,
 * `movement` and the HUD keep one code path, and a bug fixed on desktop stays
 * fixed on a phone.
 *
 * Layout (landscape, mirrored for left-handed play not implemented):
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │                                                    [II]      │
 *   │                                                              │
 *   │                          (look / aim: any drag here)         │
 *   │                                                              │
 *   │   ╭───╮                          [R]  [⤒]                   │
 *   │   │ ◎ │  joystick                [⤓]  [＋]  [◎ FIRE]        │
 *   │   ╰───╯                                                      │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Multi-touch:
 *   Every pointer is tracked by `pointerId`, and it keeps the role it was given
 *   at `pointerdown` for its whole life: one thumb on the stick, another aiming,
 *   a third holding fire (which also aims — the fire button doubles as a look
 *   pad, exactly the way a thumb works on a real controller), all at once.
 *
 * Look:
 *   Deliberately NOT `movementX`: touch pointers report no useful movement
 *   delta on every browser, so each pointer keeps its own last position and the
 *   difference is handed to `input.addTouchLook()`, which converts it with the
 *   touch sensitivity curve and clamps spikes.
 *
 * Sprint:
 *   Deflection past the outer band of the stick presses `ShiftLeft`, matching
 *   the "flick the stick to sprint" convention and the gamepad path in
 *   `movement.js`.
 *
 * The first touch also dismisses the deploy gate, which is where Web Audio is
 * unlocked (the audio subsystem arms a global gesture listener) and the
 * simulation is allowed to start — a phone boots the level frozen behind a
 * "TAP TO DEPLOY" panel rather than simulating an unseen firefight.
 */

const MOVE_ZONE_X = 0.46; // left share of the screen that engages the stick
const MOVE_ZONE_Y = 0.34; // ignore the top band so HUD taps don't grab it
const STICK_RADIUS = 62; // thumb travel in CSS px
const SPRINT_AT = 0.84; // deflection that counts as sprint
const STICK_HOME_LEFT = 34;
const STICK_HOME_BOTTOM = 34;

const CSS = `
#ow-touch {
  position: fixed; inset: 0;
  z-index: 8;
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  font-family: "Avenir Next Condensed","DIN Alternate","Roboto Condensed","Arial Narrow","Helvetica Neue",system-ui,sans-serif;
  font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
  color: rgba(240,246,250,.95);
  overflow: hidden;
  pointer-events: auto;
}
#ow-touch.off { display: none; }
/* Paused: the controls are still there but must not read as available, and a
   translucent menu lets them show through unless they are faded down. */
#ow-touch.paused .ow-t-btn,
#ow-touch.paused .ow-t-throw,
#ow-touch.paused .ow-t-stick-home,
#ow-touch.paused .ow-t-stick,
#ow-touch.paused .ow-t-pause { opacity: .14; transition: opacity .15s linear; }

/* ---- joystick ---------------------------------------------------------- */
.ow-t-stick {
  position: absolute; width: 132px; height: 132px; margin: -66px 0 0 -66px;
  left: 0; top: 0; opacity: 0; transition: opacity .12s linear;
  will-change: transform, opacity;
}
.ow-t-stick.live { opacity: 1; }
.ow-t-stick-base {
  position: absolute; inset: 0; border-radius: 50%;
  border: 1.5px solid rgba(226,238,246,.28);
  background: radial-gradient(circle at 50% 50%, rgba(12,18,24,.10) 40%, rgba(8,12,16,.30) 100%);
  box-shadow: inset 0 0 24px rgba(0,0,0,.28);
}
.ow-t-stick-base::after {
  content: ''; position: absolute; inset: 12px; border-radius: 50%;
  border: 1px dashed rgba(226,238,246,.12);
}
.ow-t-stick-thumb {
  position: absolute; left: 50%; top: 50%; width: 58px; height: 58px;
  margin: -29px 0 0 -29px; border-radius: 50%;
  border: 1.5px solid rgba(236,246,252,.55);
  background: radial-gradient(circle at 44% 38%, rgba(238,247,252,.30), rgba(120,150,175,.18) 60%, rgba(10,14,18,.34) 100%);
  box-shadow: 0 2px 8px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.28);
  will-change: transform;
}
.ow-t-stick.sprint .ow-t-stick-base { border-color: rgba(255,176,42,.62); }
.ow-t-stick.sprint .ow-t-stick-thumb { border-color: rgba(255,196,90,.9); }
.ow-t-stick-home {
  /* Resting position only — the live stick (below) is the one that follows the
     thumb, and that one is centred on its touch point with a -50% offset. */
  position: absolute; left: 34px; bottom: 34px; width: 132px; height: 132px;
  margin: 0; border-radius: 50%;
  border: 1.5px solid rgba(226,238,246,.26);
  background: radial-gradient(circle at 50% 50%, rgba(10,15,20,.06) 45%, rgba(8,12,16,.22) 100%);
  box-shadow: inset 0 0 20px rgba(0,0,0,.22);
  opacity: .9; will-change: opacity;
}
.ow-t-stick-home.off { opacity: 0; }
.ow-t-stick-home::before {
  content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
  margin: -3px 0 0 -3px; border-radius: 50%; background: rgba(226,238,246,.35);
}

/* ---- action buttons ---------------------------------------------------- */
.ow-t-btn {
  position: absolute; display: grid; place-items: center;
  border-radius: 50%; border: 1.5px solid rgba(232,242,248,.34);
  background: radial-gradient(circle at 50% 36%, rgba(24,32,40,.30), rgba(7,10,13,.46) 78%);
  box-shadow: 0 3px 10px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.10);
  color: rgba(238,246,250,.92);
  font-size: 10px; line-height: 1; letter-spacing: .1em;
  text-shadow: 0 1px 2px rgba(0,0,0,.85);
  will-change: transform, background;
  transition: background .06s linear, border-color .06s linear;
}
.ow-t-btn.on {
  background: radial-gradient(circle at 50% 36%, rgba(255,196,90,.42), rgba(150,96,10,.36) 80%);
  border-color: rgba(255,196,90,.95);
  color: #fff;
}
.ow-t-btn.on.fire {
  background: radial-gradient(circle at 50% 36%, rgba(255,150,120,.40), rgba(140,30,16,.42) 80%);
  border-color: rgba(255,120,96,.95);
}
.ow-t-btn .gl {
  display: block; font-size: 20px; line-height: 1; letter-spacing: 0;
  text-shadow: 0 1px 3px rgba(0,0,0,.9);
}
.ow-t-btn .lb {
  display: block; margin-top: 2px; font-size: 8.5px; letter-spacing: .16em;
  opacity: .82;
}
.ow-t-fire { right: 16px; bottom: 16px; width: 92px; height: 92px;
  border-color: rgba(255,140,120,.38); }
.ow-t-fire .gl { font-size: 26px; }
.ow-t-ads { right: 20px; bottom: 118px; width: 58px; height: 58px; }
.ow-t-jump { right: 118px; bottom: 16px; width: 62px; height: 62px; }
.ow-t-crouch { right: 188px; bottom: 16px; width: 52px; height: 52px; }
.ow-t-reload { right: 118px; bottom: 86px; width: 52px; height: 52px; }

/* ---- throwables --------------------------------------------------------
   One button per throwable, stacked in the free column left of the FIRE/ADS
   pair (measured against the live touch + HUD rectangles at 844x390: the
   column x 604-656, y 136-250 is empty — reload starts at y 252, crouch at
   322, and the ammo readout stops at x 713). Portrait has no such column, so
   the pair lies flat between the vitals/ammo rows and the reload/jump row. */
.ow-t-throw {
  position: absolute; width: 52px; height: 52px;
  border-radius: 50%;
  display: grid; place-items: center;
  border: 1.5px solid rgba(232,242,248,.34);
  background: radial-gradient(circle at 50% 36%, rgba(24,32,40,.30), rgba(7,10,13,.46) 78%);
  box-shadow: 0 3px 10px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.10);
  color: rgba(238,246,250,.92);
  will-change: transform, background;
  transition: background .06s linear, border-color .06s linear, opacity .12s linear;
}
.ow-t-throw svg { width: 15px; height: 19px; display: block; }
.ow-t-throw .n {
  position: absolute; right: 2px; bottom: 1px;
  font-size: 11px; line-height: 1; letter-spacing: 0;
  color: #ffd08a; text-shadow: 0 1px 2px rgba(0,0,0,.95);
  font-variant-numeric: tabular-nums;
}
.ow-t-throw.on {
  background: radial-gradient(circle at 50% 36%, rgba(255,196,90,.42), rgba(150,96,10,.36) 80%);
  border-color: rgba(255,196,90,.95);
}
.ow-t-throw.empty { opacity: .30; }
.ow-t-throw.empty .n { color: rgba(238,246,250,.55); }
.ow-t-lethal { right: 188px; bottom: 144px; }
.ow-t-tactical { right: 188px; bottom: 202px; }
@media (max-aspect-ratio: 1/1) {
  /* Portrait: measured free band x 180-300, bottom 174-226 (vitals end at
     y 615, the reload row starts at 706 in a 390x844 viewport). */
  .ow-t-lethal { right: auto; left: 185px; bottom: 174px; }
  .ow-t-tactical { right: auto; left: 245px; bottom: 174px; }
}

.ow-t-pause {
  position: absolute; right: 14px; top: 14px; width: 44px; height: 44px;
  border-radius: 8px; border: 1px solid rgba(232,242,248,.34);
  background: rgba(8,12,16,.42); color: rgba(238,246,250,.92);
  display: grid; place-items: center; font-size: 12px; letter-spacing: .06em;
  text-shadow: 0 1px 2px rgba(0,0,0,.85);
}
.ow-t-pause.on { background: rgba(255,176,42,.34); border-color: #ffb02a; }

/* sticky-safe: keep the cluster clear of the home indicator / notch */
@supports (padding: max(0px)) {
  .ow-t-fire { right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); }
  .ow-t-jump { bottom: max(16px, env(safe-area-inset-bottom)); }
  .ow-t-crouch { bottom: max(16px, env(safe-area-inset-bottom)); }
  .ow-t-pause { right: max(14px, env(safe-area-inset-right)); top: max(14px, env(safe-area-inset-top)); }
  .ow-t-stick-home { left: max(34px, env(safe-area-inset-left)); bottom: max(34px, env(safe-area-inset-bottom)); }
}

/* ---- deploy gate ------------------------------------------------------- */
.ow-t-gate {
  position: absolute; inset: 0; display: grid; place-items: center;
  background:
    radial-gradient(ellipse 80% 70% at 50% 45%, rgba(6,9,12,.55), rgba(3,5,7,.92) 100%);
  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  text-align: center;
}
.ow-t-gate.off { display: none; }
.ow-t-gate-in { transform: translateY(-4px); }
.ow-t-gate-t {
  font-family: "DIN Condensed","Avenir Next Condensed","Oswald","Arial Narrow",Impact,sans-serif;
  font-size: 34px; letter-spacing: .34em; text-indent: .34em;
  text-shadow: 0 2px 10px rgba(0,0,0,.9);
}
.ow-t-gate-s {
  margin-top: 10px; font-size: 11px; letter-spacing: .34em; color: rgba(255,176,42,.95);
}
.ow-t-gate-h {
  margin-top: 26px; font-size: 10px; letter-spacing: .18em; line-height: 1.9;
  color: rgba(214,227,234,.62); text-transform: none; font-weight: 600;
}
.ow-t-gate-b {
  margin-top: 22px; display: inline-block; padding: 12px 26px;
  border: 1px solid rgba(255,176,42,.7); color: #ffd08a;
  font-size: 11px; letter-spacing: .3em;
}
.ow-t-gate-pulse { animation: ow-t-pulse 1.9s ease-in-out infinite; }
@keyframes ow-t-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }

/* ---- transient hint ---------------------------------------------------- */
.ow-t-hint {
  position: absolute; left: 50%; bottom: 132px; transform: translateX(-50%);
  padding: 7px 14px; border-radius: 2px;
  background: rgba(5,9,12,.55); font-size: 9.5px; letter-spacing: .16em;
  line-height: 1.7; text-align: center;
  /* A definite width, centred: an absolutely positioned box shrink-fits to the
     space left of its 50% offset, and the long line then overflows that box and
     gets clipped by the screen edge on a phone. A definite width wraps instead. */
  width: min(calc(100vw - 26px), 470px); white-space: normal;
  opacity: 0; transition: opacity .3s linear;
}
@media (max-aspect-ratio: 1/1) {
  /* Portrait has no free band at the bottom (vitals, ammo and the pad fill it),
     but the top is empty between the compass and the horizon. */
  .ow-t-hint { bottom: auto; top: 124px; max-width: 82vw; }
}
.ow-t-hint.live { opacity: .9; }
`;

// Same silhouettes the HUD's equipment row draws (ui/ammo.js), so the button
// and the count in the corner read as the same object.
const FRAG_ICON = `<svg viewBox="0 0 16 20" fill="rgba(255,255,255,.92)">
  <path d="M6.4 0h3.2v2.1h1.5l1.1 2H3.8l1.1-2h1.5z"/>
  <path d="M8 4.6c3.1 0 5.6 2.9 5.6 7.1S11.1 20 8 20 2.4 15.9 2.4 11.7 4.9 4.6 8 4.6z"/>
  <g stroke="rgba(0,0,0,.5)" stroke-width="0.9">
    <line x1="3" y1="9.5" x2="13" y2="9.5"/><line x1="3" y1="13" x2="13" y2="13"/>
    <line x1="3" y1="16.2" x2="13" y2="16.2"/><line x1="8" y1="5" x2="8" y2="19.6"/>
  </g>
</svg>`;
const FLASH_ICON = `<svg viewBox="0 0 16 20" fill="rgba(255,255,255,.92)">
  <path d="M6.2 0h3.6v2.4H6.2z"/>
  <path d="M4.2 3.1h7.6c.5 0 .9.4.9.9v13.4c0 1.4-1.1 2.6-2.6 2.6H5.9c-1.4 0-2.6-1.2-2.6-2.6V4c0-.5.4-.9.9-.9z"/>
  <rect x="4.6" y="6.2" width="6.8" height="1.2" fill="rgba(0,0,0,.45)"/>
  <rect x="4.6" y="9.1" width="6.8" height="1.2" fill="rgba(0,0,0,.45)"/>
</svg>`;

const GATE_HTML = `
  <div class="ow-t-gate-in">
    <div class="ow-t-gate-t">OVERWATCH</div>
    <div class="ow-t-gate-s">TACTICAL OPERATIONS</div>
    <div class="ow-t-gate-h">Left thumb moves · right thumb aims<br/>Hold FIRE to shoot and aim at the same time</div>
    <div class="ow-t-gate-b ow-t-gate-pulse">Tap to deploy</div>
  </div>`;

export class TouchControls {
  /**
   * @param {object} ctx      engine context (input, config, time, events…)
   * @param {object} platform result of core/platform.js
   * @param {object} [opts]   { gate:boolean } — gate:false for automated tests
   */
  constructor(ctx, platform, opts = {}) {
    this.ctx = ctx;
    this.config = ctx.config;
    this.platform = platform ?? this.config.platform ?? {};
    this.input = ctx.input;

    /** pointerId -> { role, code, x, y, sx, sy, moved } */
    this.pointers = new Map();
    this.stickOwner = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.stickValue = { x: 0, y: 0 };
    this.sprinting = false;
    this.gateOpen = opts.gate !== false;
    this.enabled = true;
    this.visible = true;
    this._hintTimer = 0;

    // A phone must never enter pointer lock: the document would swallow the
    // touch targets, and the drag-look path below is what aims instead.
    this.input.pointerLockAllowed = false;

    this._injectStyle();
    this._build();
    this._bind();

    if (this.gateOpen) this._freezeForGate();
    if (typeof window !== 'undefined') window.__TOUCH__ = this;
  }

  /* --------------------------------------------------------------- build -- */

  _injectStyle() {
    if (document.getElementById('ow-touch-style')) return;
    const s = document.createElement('style');
    s.id = 'ow-touch-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  _build() {
    const root = document.createElement('div');
    root.id = 'ow-touch';
    root.innerHTML = `
      <div class="ow-t-stick-home" id="ow-t-home"></div>
      <div class="ow-t-stick" id="ow-t-stick">
        <div class="ow-t-stick-base"></div>
        <div class="ow-t-stick-thumb" id="ow-t-thumb"></div>
      </div>
      <button class="ow-t-btn ow-t-jump" data-act="jump"><span class="gl">⤒</span><span class="lb">JUMP</span></button>
      <button class="ow-t-btn ow-t-crouch" data-act="crouch"><span class="gl">⤓</span><span class="lb">CROUCH</span></button>
      <button class="ow-t-btn ow-t-reload" data-act="reload"><span class="gl">⟳</span><span class="lb">RELOAD</span></button>
      <button class="ow-t-throw ow-t-lethal" data-act="lethal">${FRAG_ICON}<span class="n">2</span></button>
      <button class="ow-t-throw ow-t-tactical" data-act="tactical">${FLASH_ICON}<span class="n">1</span></button>
      <button class="ow-t-btn ow-t-ads" data-act="ads"><span class="gl">⊕</span><span class="lb">ADS</span></button>
      <button class="ow-t-btn ow-t-fire" data-act="fire"><span class="gl">◎</span><span class="lb">FIRE</span></button>
      <button class="ow-t-pause" data-act="pause"><span class="gl">❚❚</span></button>
      <div class="ow-t-hint" id="ow-t-hint"></div>
      <div class="ow-t-gate" id="ow-t-gate">${GATE_HTML}</div>`;
    document.body.appendChild(root);

    this.root = root;
    this.gate = root.querySelector('#ow-t-gate');
    this.stickEl = root.querySelector('#ow-t-stick');
    this.homeEl = root.querySelector('#ow-t-home');
    this.thumbEl = root.querySelector('#ow-t-thumb');
    this.hintEl = root.querySelector('#ow-t-hint');
    this.buttons = new Map();
    for (const b of root.querySelectorAll('[data-act]')) this.buttons.set(b.dataset.act, b);
    this._counts = { lethal: -1, tactical: -1 };
  }

  _freezeForGate() {
    const t = this.ctx.time;
    if (!t) return;
    this._gateScale = t.scale;
    if (!this._gateHeld) {
      this._gateHeld = true;
      t.scale = 0;
    }
  }

  /* ---------------------------------------------------------------- bind -- */

  _bind() {
    this._onDown = this._pointerDown.bind(this);
    this._onMove = this._pointerMove.bind(this);
    this._onUp = this._pointerUp.bind(this);
    this._onCancel = this._pointerUp.bind(this);
    this.root.addEventListener('pointerdown', this._onDown, { passive: false });
    this.root.addEventListener('pointermove', this._onMove, { passive: false });
    this.root.addEventListener('pointerup', this._onUp);
    this.root.addEventListener('pointercancel', this._onCancel);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    // The pause menu is translucent: hide the transient hint and fade the pad so
    // neither reads through it.
    this._offPause = this.ctx.events?.on?.('ui:pause', (e) => {
      if (e?.paused) this.clearHint();
    });
    // A page-level cancel (incoming call, app switch) must not leave the player
    // sprinting into a wall.
    this._onBlur = () => this.reset();
    addEventListener('blur', this._onBlur);
    addEventListener('orientationchange', () => this.reset());
  }

  /* ------------------------------------------------------------- pointer -- */

  _pointerDown(e) {
    if (!this.enabled) return;
    e.preventDefault();
    if (this.gateOpen) {
      this.start();
      return;
    }
    const act = e.target?.dataset?.act ?? e.target?.closest?.('[data-act]')?.dataset?.act;
    if (act) {
      this._pressButton(act, e.pointerId, e);
      this._capture(e);
      return;
    }
    const w = innerWidth;
    const h = innerHeight;
    const inMoveZone = e.clientX < w * MOVE_ZONE_X && e.clientY > h * MOVE_ZONE_Y;
    if (inMoveZone && this.stickOwner === null) {
      this._engageStick(e);
    } else {
      this.pointers.set(e.pointerId, {
        role: 'look',
        code: null,
        x: e.clientX,
        y: e.clientY,
        sx: e.clientX,
        sy: e.clientY,
        moved: 0,
      });
    }
    this._capture(e);
  }

  _pointerMove(e) {
    if (!this.enabled) return;
    const p = this.pointers.get(e.pointerId);
    if (this.stickOwner === e.pointerId) {
      e.preventDefault?.();
      this._dragStick(e);
      return;
    }
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    p.moved += Math.abs(dx) + Math.abs(dy);
    // Both the look area and a held fire button aim — that is the whole point
    // of the "drag to aim while firing" gesture. Utility buttons do not.
    if ((p.role === 'look' || p.role === 'fire') && (dx || dy)) this.input.addTouchLook(dx, dy);
  }

  _pointerUp(e) {
    if (this.stickOwner === e.pointerId) this._releaseStick();
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (p.code) {
      // ADS is a toggle: releasing the button must not cancel the aim, or the
      // player has to hold a button while also holding fire.
      if (p.code !== 'Mouse2') this.input.setVirtual(p.code, false);
      if (p.code !== 'Mouse2') this.buttons.get(p.act)?.classList.remove('on');
    }
    this.pointers.delete(e.pointerId);
  }

  _capture(e) {
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — nothing to capture */
    }
  }

  /* --------------------------------------------------------------- stick -- */

  _engageStick(e) {
    const r = 66;
    const x = Math.min(Math.max(e.clientX, r), innerWidth - r);
    const y = Math.min(Math.max(e.clientY, r), innerHeight - r);
    this.stickOwner = e.pointerId;
    this.stickOrigin.x = x;
    this.stickOrigin.y = y;
    this.stickEl.style.left = `${x}px`;
    this.stickEl.style.top = `${y}px`;
    this.stickEl.classList.add('live');
    this.homeEl.classList.add('off');
    this.stickValue.x = 0;
    this.stickValue.y = 0;
    this._paintStick(0, 0);
    this.input.setTouchStick(0, 0, true);
  }

  _dragStick(e) {
    let dx = e.clientX - this.stickOrigin.x;
    let dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    // Past the ring the base follows the thumb instead of clamping hard, which
    // is what makes a big slide feel continuous rather than stuck at the edge.
    if (len > STICK_RADIUS * 1.9) {
      const k = STICK_RADIUS * 1.9;
      const ex = (dx / len) * k;
      const ey = (dy / len) * k;
      this.stickOrigin.x += dx - ex;
      this.stickOrigin.y += dy - ey;
      this.stickEl.style.left = `${this.stickOrigin.x}px`;
      this.stickEl.style.top = `${this.stickOrigin.y}px`;
      dx = ex;
      dy = ey;
    }
    const norm = Math.min(1, Math.hypot(dx, dy) / STICK_RADIUS);
    const a = Math.atan2(dy, dx);
    // Slight deadzone so a resting thumb does not creep.
    const v = norm < 0.12 ? 0 : (norm - 0.12) / 0.88;
    const vx = Math.cos(a) * v;
    const vy = Math.sin(a) * v;
    this.stickValue.x = vx;
    this.stickValue.y = vy;
    this._paintStick(dx, dy);
    this.input.setTouchStick(vx, vy, true);

    const sprint = v > SPRINT_AT;
    if (sprint !== this.sprinting) {
      this.sprinting = sprint;
      this.input.setVirtual('ShiftLeft', sprint);
      this.stickEl.classList.toggle('sprint', sprint);
    }
  }

  _paintStick(dx, dy) {
    const r = Math.hypot(dx, dy);
    const k = r > STICK_RADIUS ? STICK_RADIUS / r : 1;
    this.thumbEl.style.transform = `translate(${(dx * k).toFixed(1)}px, ${(dy * k).toFixed(1)}px)`;
  }

  _releaseStick() {
    this.stickOwner = null;
    this.stickEl.classList.remove('live', 'sprint');
    this.homeEl.classList.remove('off');
    this.stickValue.x = 0;
    this.stickValue.y = 0;
    this.sprinting = false;
    this._paintStick(0, 0);
    this.input.setTouchStick(0, 0, false);
    this.input.setVirtual('ShiftLeft', false);
  }

  /* ------------------------------------------------------------- buttons -- */

  _pressButton(act, pointerId, e) {
    const map = {
      fire: 'Mouse0',
      ads: 'Mouse2',
      reload: 'KeyR',
      jump: 'Space',
      crouch: 'ControlLeft',
      pause: 'Escape',
      lethal: 'KeyG',
      tactical: 'KeyH',
    };
    const code = map[act];
    if (!code) return;
    const b = this.buttons.get(act);
    const x = e?.clientX ?? 0;
    const y = e?.clientY ?? 0;

    if (code === 'Mouse2') {
      // Toggle. `input.ads` is a held state, so the code stays down until the
      // next tap rather than for the length of the touch.
      const on = !this.input.isVirtual('Mouse2');
      this.input.setVirtual('Mouse2', on);
      b?.classList.toggle('on', on);
      this.pointers.set(pointerId, { role: 'button', act, code, x, y, moved: 0 });
      return;
    }

    this.input.setVirtual(code, true);
    b?.classList.add('on');
    // Fire also aims while held, so it is tracked like the look area.
    this.pointers.set(pointerId, {
      role: act === 'fire' ? 'fire' : 'button',
      act,
      code,
      x,
      y,
      moved: 0,
    });
  }

  /* ---------------------------------------------------------------- gate -- */

  /** Dismiss the deploy gate, unfreeze the sim and unlock audio. */
  start() {
    if (!this.gateOpen) return;
    this.gateOpen = false;
    this.gate.classList.add('off');
    const t = this.ctx.time;
    if (t && this._gateHeld) {
      t.scale = this._gateScale ?? 1;
      this._gateHeld = false;
    }
    // The audio subsystem arms a global pointerdown/keydown listener for this;
    // an explicit call covers browsers that already consumed the gesture.
    try {
      const audio = this.ctx.peek?.('audio');
      const pending = audio?.start?.();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* audio is optional — never block the first frame on it */
    }
    this.ctx.events?.emit?.('ui:start', { source: 'touch' });
    this.hint('MOVE LEFT STICK  ·  AIM RIGHT DRAG  ·  HOLD FIRE TO SHOOT', 5);
  }

  /** Re-open the gate (used by the menu's "restart" path in tests). */
  openGate() {
    if (!this.gate) return;
    this.gateOpen = true;
    this.gate.classList.remove('off');
    this._freezeForGate();
  }

  /** Drop the transient hint immediately (death screen, pause). */
  clearHint() {
    this._hintTimer = 0;
    this.hintEl?.classList.remove('live');
  }

  hint(text, seconds = 2.5) {
    this.hintEl.textContent = text;
    this.hintEl.classList.add('live');
    this._hintTimer = seconds;
  }

  /* ----------------------------------------------------------------- api -- */

  setVisible(on) {
    this.visible = on;
    this.root.classList.toggle('off', !on);
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.classList.toggle('paused', !on);
    if (!on) this.reset();
  }

  /** Release everything: used on blur, rotation and when the menu opens. */
  reset() {
    if (this.stickOwner !== null || this.stickValue.x || this.stickValue.y) this._releaseStick();
    for (const p of this.pointers.values()) {
      if (p.code && p.code !== 'Mouse2') {
        this.input.setVirtual(p.code, false);
        this.buttons.get(p.act)?.classList.remove('on');
      }
    }
    this.pointers.clear();
    for (const b of this.buttons.values()) b.classList.remove('on');
    this.input.setVirtual('Mouse0', false);
    this.input.setVirtual('Mouse2', false);
    this.input.setVirtual('ShiftLeft', false);
    this.input.setVirtual('KeyR', false);
    this.input.setVirtual('Space', false);
    this.input.setVirtual('ControlLeft', false);
    this.stickEl.classList.remove('live', 'sprint');
    this.homeEl.classList.remove('off');
  }

  /** Cheap per-frame tick for the transient hint and the throwable counts. */
  update(dt) {
    if (this._hintTimer > 0) {
      this._hintTimer -= dt;
      if (this._hintTimer <= 0) this.hintEl.classList.remove('live');
    }
    const hud = this.ctx.peek?.('weapons')?.getHudState?.();
    if (hud) {
      this._setCount('lethal', hud.lethalCount ?? 0);
      this._setCount('tactical', hud.tacticalCount ?? 0);
    }
  }

  /** Count badge + the greyed-out state, only on change. */
  _setCount(act, n) {
    if (this._counts[act] === n) return;
    this._counts[act] = n;
    const b = this.buttons.get(act);
    if (!b) return;
    const label = b.querySelector('.n');
    if (label) label.textContent = String(n);
    b.classList.toggle('empty', n <= 0);
  }

  state() {
    return {
      gate: this.gateOpen,
      stick: { x: +this.stickValue.x.toFixed(3), y: +this.stickValue.y.toFixed(3) },
      sprint: this.sprinting,
      pointers: this.pointers.size,
      fire: this.input.held('Mouse0'),
      ads: this.input.held('Mouse2'),
    };
  }

  dispose() {
    this._offPause?.();
    removeEventListener('blur', this._onBlur);
    this.root.removeEventListener('pointerdown', this._onDown);
    this.root.removeEventListener('pointermove', this._onMove);
    this.root.removeEventListener('pointerup', this._onUp);
    this.root.removeEventListener('pointercancel', this._onCancel);
    this.reset();
    this.root.remove();
    document.getElementById('ow-touch-style')?.remove();
    if (window.__TOUCH__ === this) delete window.__TOUCH__;
  }
}
