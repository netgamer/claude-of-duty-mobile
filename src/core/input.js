/**
 * Input aggregation: keyboard, mouse (pointer-locked), and gamepad, exposed as
 * a stable per-frame snapshot so gameplay never touches raw DOM events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 */

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Digit1', 'Digit2', 'Tab'],
  grenade: ['KeyG'],
  // Flashbang. The touch layout has a button per throwable, so the keyboard
  // gets one key per throwable too rather than a hidden "selected type".
  tactical: ['KeyH'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();
    /** Taps that began and ended between two frames — see setVirtual(). */
    this._tap = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /**
     * Touch devices never get pointer lock: the on-screen controls (see
     * core/touch.js) drive look by drag. Set false by TouchControls.
     */
    this.pointerLockAllowed = true;
    /**
     * Virtual (on-screen) buttons live in the same `down` set as real keys, so
     * every consumer — `action()`, `actionPressed()`, `fire`, `ads` — works on a
     * phone without a single gameplay change. Codes pressed this way are
     * remembered in `virtual` so a focus loss can tell them apart from a
     * physically held key and the HUD can light the right button.
     */
    this.virtual = new Set();
    /** Analog movement written by the touch joystick, merged in after the pad. */
    this.touch = { moveX: 0, moveY: 0, sprint: 0, active: false };
    /** Drag-look accumulated since the last frame, in CSS pixels. */
    this._touchLook = { x: 0, y: 0 };
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  requestPointerLock() {
    // Touch builds never take the pointer: locking it would stop the document
    // from delivering the touch targets the on-screen controls need.
    if (!this.pointerLockAllowed) return;
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(e.code);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    // On a phone a stray mouse/trackpad click must not enter pointer lock: the
    // document would stop delivering touch targets the way the controls need.
    if (!this.pointerLocked && e.button === 0 && this.pointerLockAllowed) this.requestPointerLock();
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this._onBlur();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    for (const code of this.down) this._pendingUp.add(code);
    this._tap.clear();
    this._rawLook.x = 0;
    this._rawLook.y = 0;
    this._touchLook.x = 0;
    this._touchLook.y = 0;
    if (this.touch) {
      this.touch.moveX = 0;
      this.touch.moveY = 0;
      this.touch.active = false;
    }
  }

  /* ---------------------------------------------------- virtual buttons --- */

  /**
   * Press or release a key code from an on-screen control.
   *
   * Routed through the same pending queues as a real key so the edge sets
   * (`pressed` / `released`) stay correct even when a tap starts and ends
   * inside one frame, and so nothing downstream can tell the two apart.
   */
  setVirtual(code, on) {
    if (on) {
      if (!this.down.has(code) && !this._pendingDown.has(code)) this._pendingDown.add(code);
      this._pendingUp.delete(code);
      this._tap.delete(code);
      this.virtual.add(code);
    } else {
      if (this._pendingDown.has(code)) {
        // Pressed and released before a frame ran. A thumb tap on a phone is
        // shorter than one 60 Hz frame often enough to matter, and dropping the
        // edge here is how RELOAD and CROUCH silently stopped working on a
        // slow frame. Deliver it as a one-frame tap instead of cancelling it.
        this._pendingDown.delete(code);
        this._tap.add(code);
      } else if (this.down.has(code)) {
        this._pendingUp.add(code);
      }
      this.virtual.delete(code);
    }
  }

  /** True when the code is currently held by an on-screen control. */
  isVirtual(code) {
    return this.virtual.has(code);
  }

  /**
   * Add a touch drag to this frame's look, in CSS pixels.
   *
   * Converted at the end of the frame by `touchSensitivity` instead of
   * `sensitivity`, so a thumb swipe and a mouse flick can feel right at the
   * same time. Clamped per event so a dropped frame or a stray event burst
   * cannot spin the view.
   */
  addTouchLook(dx, dy) {
    if (!this.enabled || this.frozen) return;
    const max = this.config.platform?.touchLookClamp ?? 220;
    this._touchLook.x += Math.max(-max, Math.min(max, dx));
    this._touchLook.y += Math.max(-max, Math.min(max, dy));
  }

  /** Analog stick vector from the touch joystick, y positive = backwards. */
  setTouchStick(x, y, active) {
    this.touch.moveX = x;
    this.touch.moveY = y;
    this.touch.active = active;
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (const code of this._tap) {
      this._pressed.add(code);
      this._released.add(code);
    }
    this._tap.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    const ts = this.config.touchSensitivity ?? s;
    const inv = this.config.invertY ? -1 : 1;
    this.look.x = this.frozen ? 0 : this._rawLook.x * s + this._touchLook.x * ts;
    this.look.y = this.frozen ? 0 : (this._rawLook.y * s + this._touchLook.y * ts) * inv;
    this._rawLook.x = 0;
    this._rawLook.y = 0;
    this._touchLook.x = 0;
    this._touchLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
    // The joystick wins over a pad only while a thumb is actually on it, so
    // plugging a controller into a tablet still works.
    if (this.touch.active) {
      this.stick.moveX = this.touch.moveX;
      this.stick.moveY = this.touch.moveY;
      this.stick.lookX = 0;
      this.stick.lookY = 0;
    }
  }

  endFrame() {}

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.stick.moveX = dz(pad.axes[0] ?? 0);
    this.stick.moveY = dz(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;
    this.stick.lookX = curve(dz(pad.axes[2] ?? 0));
    this.stick.lookY = curve(dz(pad.axes[3] ?? 0));
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0');
  }

  get firePressed() {
    return this._pressed.has('Mouse0');
  }

  get ads() {
    return this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
