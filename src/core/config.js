/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  /**
   * Phone budget. Below `low` on every axis that costs fill rate or bandwidth:
   * a quarter of the pixels, two shadow cascades at 1024, no temporal filter,
   * no GTAO/SSR/volumetrics/motion blur, and small particle/decal pools. The
   * screen is physically tiny, so the loss is far less visible there than the
   * framerate it buys. `maxPixelRatio` is the hard DPR ceiling — 3x DPR on a
   * 1080p phone is an 8 MP backbuffer and a lost WebGL context.
   */
  mobile: {
    renderScale: 0.62,
    maxPixelRatio: 1.25,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 45,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    dof: false,
    bloom: true,
    anisotropy: 2,
    particleBudget: 1200,
    decalBudget: 32,
    /** Dynamic resolution: drop the internal scale when frames get long. */
    adaptive: true,
  },
  low: {
    renderScale: 0.72,
    maxPixelRatio: 1.5,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.85,
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    maxPixelRatio: 1.5,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  /**
   * Touch look, in radians per CSS pixel of drag. Kept apart from
   * `sensitivity` because a thumb stroke is a different gesture from a mouse
   * flick: ~0.0038 rad/px turns a full 844 px screen sweep into ~180deg, while
   * the mouse value would only manage 25deg. The settings slider scales both.
   */
  touchSensitivity: 0.0038,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Result of core/platform.js — null on a plain desktop browser. */
  platform: null,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  if (!QUALITY_PRESETS[cfg.quality]) cfg.quality = DEFAULTS.quality;
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  const platform = cfg.platform;
  if (platform?.touchSensitivity) cfg.touchSensitivity = platform.touchSensitivity;
  if (platform?.maxPixelRatio) cfg.q.maxPixelRatio = Math.min(cfg.q.maxPixelRatio ?? 1.5, platform.maxPixelRatio);
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
    const cap = cfg.platform?.maxPixelRatio;
    if (cap) cfg.q.maxPixelRatio = Math.min(cfg.q.maxPixelRatio ?? 1.5, cap);
  };
  return cfg;
}
