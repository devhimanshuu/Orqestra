import { describe, expect, it } from "vitest";
import { MARK_CORNER_RADIUS, MARK_EDGE_MAX, MARK_EDGE_MIN, MARK_RING_START } from "./mark-geometry";
import { MARK_PATH_LENGTH, pointOnMarkPath } from "./mark-path";

const R = MARK_CORNER_RADIUS;
const MIN = MARK_EDGE_MIN;
const MAX = MARK_EDGE_MAX;

/** Straight edges of the centreline, as point pairs. */
const EDGES: [number, number, number, number][] = [
  [MIN + R, MIN, MAX - R, MIN],
  [MAX, MIN + R, MAX, MAX - R],
  [MAX - R, MAX, MIN + R, MAX],
  [MIN, MAX - R, MIN, MIN + R],
];

/** Corner arc centres. */
const CORNERS: [number, number][] = [
  [MAX - R, MIN + R],
  [MAX - R, MAX - R],
  [MIN + R, MAX - R],
  [MIN + R, MIN + R],
];

function distanceToSegment(
  x: number,
  y: number,
  [ax, ay, bx, by]: [number, number, number, number],
) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const u =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  return Math.hypot(x - (ax + u * dx), y - (ay + u * dy));
}

/** How far a point is from the ring's centreline; 0 means it is exactly on it. */
function distanceToCentreline({ x, y }: { x: number; y: number }): number {
  const edges = Math.min(...EDGES.map((edge) => distanceToSegment(x, y, edge)));
  const arcs = Math.min(...CORNERS.map(([cx, cy]) => Math.abs(Math.hypot(x - cx, y - cy) - R)));
  return Math.min(edges, arcs);
}

describe("mark path", () => {
  it("is one lap of the squircle", () => {
    // Four quarter arcs joined by four equal straight edges: the gap between
    // the corner tangents, i.e. (MAX - R) - (MIN + R).
    const expected = 4 * ((Math.PI / 2) * R) + 4 * (MAX - R - (MIN + R));
    expect(MARK_PATH_LENGTH).toBeCloseTo(expected, 6);
  });

  it("starts where the ring path starts", () => {
    const start = pointOnMarkPath(0);
    expect(start.x).toBeCloseTo(MARK_RING_START.x, 6);
    expect(start.y).toBeCloseTo(MARK_RING_START.y, 6);
  });

  it("stays on the centreline for the whole lap", () => {
    let worst = 0;
    for (let i = 0; i < 256; i++) {
      worst = Math.max(worst, distanceToCentreline(pointOnMarkPath(i / 256)));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("traverses the ring exactly once", () => {
    const steps = 720;
    let walked = 0;
    for (let i = 0; i < steps; i++) {
      const from = pointOnMarkPath(i / steps);
      const to = pointOnMarkPath((i + 1) / steps);
      walked += Math.hypot(to.x - from.x, to.y - from.y);
    }
    // Chords slightly under-measure a curve; a second lap would overshoot wildly.
    expect(walked / MARK_PATH_LENGTH).toBeCloseTo(1, 4);
  });

  it("runs clockwise and wraps in both directions", () => {
    // A quarter of the way round is the middle of the right edge.
    const quarter = pointOnMarkPath(0.25);
    expect(quarter.x).toBeCloseTo(MAX, 6);
    expect(quarter.y).toBeGreaterThan(MIN);
    expect(quarter.y).toBeLessThan(MAX);

    expect(pointOnMarkPath(1)).toEqual(pointOnMarkPath(0));
    expect(pointOnMarkPath(-0.25)).toEqual(pointOnMarkPath(0.75));
    expect(pointOnMarkPath(5.5)).toEqual(pointOnMarkPath(0.5));
  });
});
