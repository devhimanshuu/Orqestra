/**
 * How the hero's sweep answers the pointer.
 *
 * The light leans toward the pointer, and comes up to full strength as the
 * pointer closes on its focal point — the caustic where the arcs meet the right
 * edge. Nothing here can brighten past the drawn artwork: the *resting* state
 * (`1`) is the hero exactly as designed, and the interaction only ever offsets
 * and dims it. A visitor without scripting, a visitor with reduced motion, and a
 * visitor who simply stands still therefore all see the same hero.
 *
 * Pure maths, kept apart from the DOM so the mapping and the easing can be
 * tested directly.
 */

export interface SweepState {
  /** Focal offset in the sweep's own 1440×900 units. */
  x: number;
  y: number;
  /** Dimmer for the flare at the focus, 0…1 (1 = as drawn). */
  glow: number;
  /** Dimmer for the arcs, 0…1 (1 = as drawn). */
  lit: number;
}

/** Travel of the focal point at full deflection, in the sweep's units. */
export const SWEEP_TRAVEL = { x: 78, y: 54 } as const;

/** Strength at the far corner of the hero, as a fraction of the drawn look. */
export const SWEEP_DIM = { glow: 0.62, lit: 0.86 } as const;

/** Seconds for the light to cover about 63% of the distance to its target. */
export const SWEEP_EASE_SECONDS = 0.16;

/**
 * How far the arcs travel against the focal point: a third, so the light leans
 * toward the pointer instead of sliding off its own beams.
 */
export const ARCS_TRAIL = 0.34;

/** The drawn hero: no offset, no dimming. */
export const SWEEP_REST: SweepState = { x: 0, y: 0, glow: 1, lit: 1 };

/** Where the caustic already sits: the right edge, mid-height, in −1…1 space. */
const FOCUS = { x: 1, y: 0 } as const;

/** Distance from the focus to the opposite corner — the far end of the response. */
const FARTHEST = Math.hypot(FOCUS.x + 1, FOCUS.y + 1);

const clamp = (value: number, min = -1, max = 1) => Math.min(max, Math.max(min, value));

/**
 * The light's target for a pointer at `offsetX`/`offsetY`, given in −1…1 across
 * the hero (−1 = left/top, 1 = right/bottom).
 */
export function sweepTarget(offsetX: number, offsetY: number): SweepState {
  const nx = clamp(offsetX);
  const ny = clamp(offsetY);
  const proximity = clamp(1 - Math.hypot(nx - FOCUS.x, ny - FOCUS.y) / FARTHEST, 0, 1);

  return {
    x: nx * SWEEP_TRAVEL.x,
    y: ny * SWEEP_TRAVEL.y,
    glow: SWEEP_DIM.glow + (1 - SWEEP_DIM.glow) * proximity,
    lit: SWEEP_DIM.lit + (1 - SWEEP_DIM.lit) * proximity,
  };
}

/**
 * One step of the easing: a first-order approach that is frame-rate independent
 * and cannot overshoot, so the light arrives rather than snapping or bouncing.
 */
export function approach(current: number, target: number, elapsedSeconds: number): number {
  if (!(elapsedSeconds > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-elapsedSeconds / SWEEP_EASE_SECONDS));
}

/** The whole state, stepped once. */
export function advance(state: SweepState, target: SweepState, elapsedSeconds: number): SweepState {
  return {
    x: approach(state.x, target.x, elapsedSeconds),
    y: approach(state.y, target.y, elapsedSeconds),
    glow: approach(state.glow, target.glow, elapsedSeconds),
    lit: approach(state.lit, target.lit, elapsedSeconds),
  };
}

/** Tolerances are per unit: positions in sweep units, dimmers in 0…1. */
export function sweepSettled(state: SweepState, target: SweepState): boolean {
  return (
    Math.abs(state.x - target.x) < 0.4 &&
    Math.abs(state.y - target.y) < 0.4 &&
    Math.abs(state.glow - target.glow) < 0.004 &&
    Math.abs(state.lit - target.lit) < 0.004
  );
}
