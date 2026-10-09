import {
  MARK_FIELD_COLOR,
  MARK_FIELD_RADIUS,
  MARK_GRID,
  MARK_INK_COLOR,
  MARK_MOTION_PATH,
  MARK_NODE,
  MARK_RING_PATH,
  MARK_STROKE,
} from "./mark-geometry";
import { pointOnMarkPath } from "./mark-path";

/**
 * The mark's motion.
 *
 * The node leaves the core and rides the harness — one lap of the ring's
 * centreline, unhurried, at constant speed. Slow enough to read as craft rather
 * than as a spinner: at nav size the node covers about seven pixels a second.
 * A barely-there ghost trails it so the eye reads direction rather than a dot
 * blinking around a ring.
 *
 * Every lap then *lands*: the moment the node is back where it set off, the core
 * node beats — a quick swell, and a ring of light leaving it. It is the one
 * flourish in the mark, and it is placed at the head of a new lap so the motion
 * reads as a circuit completing, then acknowledging it.
 *
 * Four surfaces share these numbers: the drawn mark (`orqestra-mark.tsx`, via
 * SMIL), the tab icon (`use-orbit-favicon.ts`, one frame at a time), the
 * standalone asset written by `scripts/generate-icons.ts`, and the tests.
 */

/** One lap, in seconds. */
export const MARK_ORBIT_SECONDS = 9;

/** The travelling node, and the ghost a beat behind it. */
export const MARK_RIDER_RADIUS = 2.2;
export const MARK_TRAIL_RADIUS = 1.3;
export const MARK_TRAIL_LAG_SECONDS = 0.28;
export const MARK_TRAIL_OPACITY = 0.4;

/**
 * The beat, as fractions of a lap measured from its boundary: it opens the cycle
 * that follows a completed lap, is at its fullest almost immediately, and is
 * over well before that lap is a tenth done — so the resting dot and the swollen
 * one never disagree across cycles.
 */
export const MARK_POP_PEAK = 0.018;
export const MARK_POP_END = 0.06;

/** Peak sizes, as multiples of the resting node: the core swells, the halo leaves. */
export const MARK_POP_CORE_SCALE = 1.62;
export const MARK_POP_HALO_SCALE = 3.4;
export const MARK_POP_HALO_OPACITY = 0.45;

/** The ring of light is a hairline — a fraction of the harness ring's stroke. */
export const MARK_STROKE_FRACTION = 0.6;

/** Tab icon: ~8 frames a second is smooth for a 16px glyph and cheap to swap. */
export const FAVICON_FRAME_MS = 125;

const duration = `${MARK_ORBIT_SECONDS}s`;

/** Trims float noise so generated frames are byte-stable. */
const n = (value: number) => Number(value.toFixed(3));

/** Keyframe times and easing shared by the drawn mark, the frames and the asset. */
const at = (value: number) => String(Number(value.toFixed(4)));

/** Constant, then an ease-out swell, then a settle back to rest. */
const SPLINES = {
  still: "0 0 1 1",
  swell: "0.16 1 0.3 1",
  settle: "0.45 0 0.55 1",
  leave: "0.3 0 0.7 1",
} as const;

const REST = MARK_NODE.r;
const CORE_PEAK = n(REST * MARK_POP_CORE_SCALE);
const HALO_PEAK = n(REST * MARK_POP_HALO_SCALE);

/**
 * The motion attributes for a node (or its ghost), as plain values so the
 * component stays declarative and the generated asset stays readable.
 *
 * The ghost *starts late* by its lag, which is what puts it behind the node: a
 * repeating path animation delayed by 0.28s is re-tracing what the node did
 * 0.28s ago. (A negative offset would run it ahead of the node instead.)
 */
export const MARK_MOTION = {
  path: MARK_MOTION_PATH,
  duration,
  trailDelay: `${MARK_TRAIL_LAG_SECONDS}s`,
} as const;

/**
 * The beat, as SMIL attribute strings — read by `orqestra-mark.tsx` (as props)
 * and by {@link markAnimatedSvg} (as markup), so the two can never disagree.
 *
 * `markPop` below computes the same curve for the tab icon's frames; the tests
 * hold both to the keyframes listed here.
 */
export const MARK_POP_MOTION = {
  duration,
  coreValues: `${REST};${CORE_PEAK};${REST};${REST}`,
  coreKeyTimes: `0;${at(MARK_POP_PEAK)};${at(MARK_POP_END)};1`,
  coreKeySplines: `${SPLINES.swell};${SPLINES.settle};${SPLINES.still}`,
  haloRadiusValues: `${REST};${HALO_PEAK};${HALO_PEAK}`,
  haloRadiusKeyTimes: `0;${at(MARK_POP_END)};1`,
  haloRadiusKeySplines: `${SPLINES.leave};${SPLINES.still}`,
  haloOpacityValues: `0;${MARK_POP_HALO_OPACITY};0;0`,
  haloOpacityKeyTimes: `0;${at(MARK_POP_PEAK)};${at(MARK_POP_END)};1`,
  haloOpacityKeySplines: `${SPLINES.swell};${SPLINES.settle};${SPLINES.still}`,
} as const;

export interface MarkPop {
  /** Radius of the core node at this moment, in grid units. */
  core: number;
  /** Radius of the ring of light leaving the core. */
  halo: number;
  haloOpacity: number;
}

const easeOut = (u: number) => 1 - (1 - u) ** 3;
const easeInOut = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);

/**
 * The beat at lap phase `t` (0…1): at rest for most of the lap, then a swell of
 * the core the instant a lap closes, a ring of light expanding out of it, and a
 * settle back to rest. Frame-by-frame surfaces (the tab icon) draw from this;
 * the SMIL surfaces interpolate {@link MARK_POP_MOTION}, which agrees with it
 * exactly at every keyframe.
 */
export function markPop(t: number): MarkPop {
  const rest: MarkPop = { core: REST, halo: REST, haloOpacity: 0 };
  const phase = ((t % 1) + 1) % 1;
  if (phase >= MARK_POP_END) return rest;

  // Through the beat as a whole, then up to its peak and away from it, as 0…1.
  const progress = phase / MARK_POP_END;
  const windUp = phase / MARK_POP_PEAK;
  const settle = (phase - MARK_POP_PEAK) / (MARK_POP_END - MARK_POP_PEAK);
  const swell = phase <= MARK_POP_PEAK ? easeOut(windUp) : 1 - easeInOut(settle);
  const fade = phase <= MARK_POP_PEAK ? windUp : 1 - easeInOut(settle);

  return {
    core: REST * (1 + (MARK_POP_CORE_SCALE - 1) * swell),
    halo: REST * (1 + (MARK_POP_HALO_SCALE - 1) * progress),
    haloOpacity: MARK_POP_HALO_OPACITY * fade,
  };
}

/** A ring with the node at phase `t` and the core mid-beat — the mark at one moment. */
function ringWithNode(t: number): string {
  const rider = pointOnMarkPath(t);
  const trail = pointOnMarkPath(t - MARK_TRAIL_LAG_SECONDS / MARK_ORBIT_SECONDS);
  const pop = markPop(t);
  const halo =
    pop.haloOpacity > 0.01
      ? `<circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${n(pop.halo)}" fill="none" stroke="${MARK_INK_COLOR}" stroke-width="${n(MARK_STROKE * MARK_STROKE_FRACTION)}" opacity="${n(pop.haloOpacity)}"/>`
      : "";

  return [
    `<path d="${MARK_RING_PATH}" fill="none" stroke="${MARK_INK_COLOR}" stroke-width="${MARK_STROKE}" stroke-linejoin="round"/>`,
    `<circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${n(pop.core)}" fill="${MARK_INK_COLOR}"/>`,
    halo,
    `<circle cx="${n(trail.x)}" cy="${n(trail.y)}" r="${MARK_TRAIL_RADIUS}" fill="${MARK_INK_COLOR}" opacity="${MARK_TRAIL_OPACITY}"/>`,
    `<circle cx="${n(rider.x)}" cy="${n(rider.y)}" r="${MARK_RIDER_RADIUS}" fill="${MARK_INK_COLOR}"/>`,
  ]
    .filter(Boolean)
    .join("\n  ");
}

/**
 * One frame of the animated tab icon: the mark on its dark field, with the node
 * at phase `t` (0…1 around the ring). Scalable — no intrinsic size, so a HiDPI
 * tab strip renders it from the vector rather than from a resampled bitmap.
 */
export function markFrameSvg(t: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_GRID} ${MARK_GRID}">
  <rect width="${MARK_GRID}" height="${MARK_GRID}" rx="${MARK_FIELD_RADIUS}" fill="${MARK_FIELD_COLOR}"/>
  ${ringWithNode(t)}
</svg>`;
}

/**
 * The animated mark as a standalone file (`public/orqestra-mark-animated.svg`),
 * for anywhere React is not: docs, decks, an `<img>` on a page.
 *
 * It animates with SMIL so it keeps moving when embedded as an image, and its
 * static state — what a renderer without SMIL shows, and what the first painted
 * frame looks like — is the node parked on the ring, not a stray dot.
 */
export function markAnimatedSvg(): string {
  const rider = pointOnMarkPath(0);
  const pop = MARK_POP_MOTION;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_GRID} ${MARK_GRID}" aria-label="Orqestra" role="img">
  <!--
    The Orqestra mark in motion: the node rides the harness, and the core beats
    as each lap closes. Generated by \`pnpm icons\` from src/components/brand/
    mark-geometry and mark-animation — edit those, not this file. Without SMIL
    support the node rests on the band and the core stays at rest.
  -->
  <rect width="${MARK_GRID}" height="${MARK_GRID}" rx="${MARK_FIELD_RADIUS}" fill="${MARK_FIELD_COLOR}"/>
  <path d="${MARK_RING_PATH}" fill="none" stroke="${MARK_INK_COLOR}" stroke-width="${MARK_STROKE}" stroke-linejoin="round"/>
  <circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${MARK_NODE.r}" fill="${MARK_INK_COLOR}"/>
  <circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${MARK_NODE.r}" fill="${MARK_INK_COLOR}">
    <animate attributeName="r" dur="${pop.duration}" values="${pop.coreValues}" keyTimes="${pop.coreKeyTimes}" keySplines="${pop.coreKeySplines}" calcMode="spline" repeatCount="indefinite"/>
  </circle>
  <circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${MARK_NODE.r}" fill="none" stroke="${MARK_INK_COLOR}" stroke-width="${n(MARK_STROKE * MARK_STROKE_FRACTION)}" opacity="0">
    <animate attributeName="r" dur="${pop.duration}" values="${pop.haloRadiusValues}" keyTimes="${pop.haloRadiusKeyTimes}" keySplines="${pop.haloRadiusKeySplines}" calcMode="spline" repeatCount="indefinite"/>
    <animate attributeName="opacity" dur="${pop.duration}" values="${pop.haloOpacityValues}" keyTimes="${pop.haloOpacityKeyTimes}" keySplines="${pop.haloOpacityKeySplines}" calcMode="spline" repeatCount="indefinite"/>
  </circle>
  <circle cx="${n(rider.x)}" cy="${n(rider.y)}" r="${MARK_TRAIL_RADIUS}" fill="${MARK_INK_COLOR}" opacity="${MARK_TRAIL_OPACITY}">
    <animateMotion dur="${duration}" begin="${MARK_MOTION.trailDelay}" repeatCount="indefinite" path="${MARK_MOTION_PATH}"/>
  </circle>
  <circle cx="${n(rider.x)}" cy="${n(rider.y)}" r="${MARK_RIDER_RADIUS}" fill="${MARK_INK_COLOR}">
    <animateMotion dur="${duration}" repeatCount="indefinite" path="${MARK_MOTION_PATH}"/>
  </circle>
</svg>
`;
}
