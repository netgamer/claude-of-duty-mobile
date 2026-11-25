/**
 * PLATFORM — one place that answers "what are we running on?".
 *
 * The game is authored for a mouse + keyboard at 1920x1080. Everything that
 * has to differ on a phone (input mode, the render resolution cap, the default
 * quality preset, how big an on-screen control has to be) is decided here so no
 * subsystem has to sniff the user agent on its own.
 *
 * Detection is deliberately conservative: a laptop with a touchscreen keeps the
 * desktop path (it has a mouse and a keyboard), and a phone always takes the
 * touch path even when the browser reports `(pointer: fine)` for a connected
 * stylus.
 *
 * Both answers can be forced from the URL, which is what the mobile smoke test
 * (`tools/mobile-test.mjs`) and manual QA use:
 *
 *   ?touch=1   pretend to be a touch device        ?touch=0   never
 *   ?mobile=1  force the mobile quality budget     ?mobile=0  never
 */

const UA_MOBILE = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|PlayBook|Opera Mini|IEMobile/i;
/** iPadOS 13+ reports a desktop Mac UA; the touch count is the only tell. */
const UA_MAC = /Macintosh/i;

export function detectPlatform(search = typeof location !== 'undefined' ? location.search : '') {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const params = new URLSearchParams(search || '');
  const ua = nav.userAgent || '';
  const maxTouch = nav.maxTouchPoints ?? 0;
  const hasMatchMedia = typeof matchMedia === 'function';
  const coarse = hasMatchMedia ? matchMedia('(pointer: coarse)').matches : false;
  const noHover = hasMatchMedia ? matchMedia('(hover: none)').matches : false;
  const uaMobile = UA_MOBILE.test(ua) || (UA_MAC.test(ua) && maxTouch > 1);

  // A phone/tablet: touch capable AND either a mobile UA or no hovering pointer.
  let touch = maxTouch > 0 && (uaMobile || (coarse && noHover));
  // A desktop browser asked to emulate touch (devtools device mode) still has a
  // mouse, so `coarse` alone must not flip it. Only the explicit override does.
  const forcedTouch = params.get('touch');
  if (forcedTouch === '1') touch = true;
  else if (forcedTouch === '0') touch = false;

  let mobile = touch && (uaMobile || maxTouch > 1);
  const forcedMobile = params.get('mobile');
  if (forcedMobile === '1') mobile = true;
  else if (forcedMobile === '0') mobile = false;

  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const screenW = typeof screen !== 'undefined' ? screen.width : 0;
  const screenH = typeof screen !== 'undefined' ? screen.height : 0;
  const shortEdge = Math.min(screenW || 1080, screenH || 1920);

  // Phones are fill-rate bound, not vertex bound: the backbuffer is the single
  // biggest lever, so the cap is tighter on a small screen than on a tablet.
  // 1.25 on a 1080p phone is a ~2.2 MP buffer; 3x DPR would be 8 MP and lose
  // the WebGL context on anything mid-range.
  const maxPixelRatio = mobile ? (shortEdge <= 480 ? 1.25 : 1.5) : 1.5;

  return {
    /** Touch input with on-screen controls. */
    touch,
    /** Mobile quality/thermals budget (also implies touch in practice). */
    mobile,
    coarse,
    noHover,
    uaMobile,
    maxTouch,
    dpr,
    screenW,
    screenH,
    maxPixelRatio,
    /** Default preset when the URL does not pin one. */
    quality: touch ? 'mobile' : 'ultra',
    /** rad per CSS pixel of drag on the look area (mouse uses config.sensitivity). */
    touchSensitivity: 0.0038,
    /** Longest single touch-look delta to accept, in CSS px (spike guard). */
    touchLookClamp: 220,
  };
}

/** True when running inside a standalone/home-screen app rather than a tab. */
export function isStandalone() {
  try {
    return (
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches ||
      navigator.standalone === true
    );
  } catch {
    return false;
  }
}
