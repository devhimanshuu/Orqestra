import { MARK_CORNER_RADIUS, MARK_EDGE_MAX, MARK_EDGE_MIN } from "./mark-geometry";

/**
 * Position along the ring's centreline.
 *
 * The animated mark travels this path, and the favicon frames are drawn from it,
 * so the arithmetic is kept in one place with the geometry it belongs to. The
 * squircle is four quarter arcs joined by four straight edges, walked clockwise
 * from the ring path's start — the same order `MARK_RING_PATH` draws.
 *
 * Pure and dependency-free: the tests assert that every sampled point really is
 * on the band (distance to the nearest edge or corner arc = the radius), which is
 * what keeps a future tweak to the corner radius from sending the node off the
 * ring.
 */

const R = MARK_CORNER_RADIUS;
const MIN = MARK_EDGE_MIN;
const MAX = MARK_EDGE_MAX;
const QUARTER = Math.PI / 2;

interface Point {
  x: number;
  y: number;
}

interface Segment {
  /** Length in grid units. */
  length: number;
  /** Point at fraction `u` of this segment. */
  at(u: number): Point;
}

/** A quarter arc, sweeping clockwise (increasing angle in SVG's y-down space). */
function arc(centreX: number, centreY: number, from: number, to: number): Segment {
  return {
    length: R * Math.abs(to - from),
    at: (u) => {
      const angle = from + (to - from) * u;
      return { x: centreX + R * Math.cos(angle), y: centreY + R * Math.sin(angle) };
    },
  };
}

function edge(from: Point, to: Point): Segment {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  return {
    length,
    at: (u) => ({ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u }),
  };
}

/**
 * The ring's centreline as eight segments, clockwise from the ring path's start.
 * Typed as a non-empty tuple: a lap always has a first segment to fall back to.
 */
const SEGMENTS: [Segment, Segment, ...Segment[]] = [
  arc(MAX - R, MIN + R, -QUARTER, 0),
  edge({ x: MAX, y: MIN + R }, { x: MAX, y: MAX - R }),
  arc(MAX - R, MAX - R, 0, QUARTER),
  edge({ x: MAX - R, y: MAX }, { x: MIN + R, y: MAX }),
  arc(MIN + R, MAX - R, QUARTER, 2 * QUARTER),
  edge({ x: MIN, y: MAX - R }, { x: MIN, y: MIN + R }),
  arc(MIN + R, MIN + R, 2 * QUARTER, 3 * QUARTER),
  edge({ x: MIN + R, y: MIN }, { x: MAX - R, y: MIN }),
];

/** Length of one full lap, in grid units. */
export const MARK_PATH_LENGTH = SEGMENTS.reduce((total, segment) => total + segment.length, 0);

/**
 * The point at phase `t` around the ring: 0 and 1 are the start, 0.5 is halfway.
 * Values outside 0…1 wrap, so callers can drive it straight from a clock.
 */
export function pointOnMarkPath(t: number): Point {
  const phase = ((t % 1) + 1) % 1;
  let remaining = phase * MARK_PATH_LENGTH;

  for (const segment of SEGMENTS) {
    if (remaining <= segment.length) {
      return segment.at(segment.length === 0 ? 0 : remaining / segment.length);
    }
    remaining -= segment.length;
  }

  return SEGMENTS[0].at(0);
}
