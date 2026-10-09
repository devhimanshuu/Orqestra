import { describe, expect, it } from "vitest";
import {
  MARK_MOTION,
  MARK_ORBIT_SECONDS,
  MARK_POP_CORE_SCALE,
  MARK_POP_END,
  MARK_POP_HALO_OPACITY,
  MARK_POP_HALO_SCALE,
  MARK_POP_MOTION,
  MARK_POP_PEAK,
  MARK_TRAIL_LAG_SECONDS,
  MARK_TRAIL_RADIUS,
  markAnimatedSvg,
  markFrameSvg,
  markPop,
} from "./mark-animation";
import { MARK_MOTION_PATH, MARK_NODE, MARK_RING_PATH, MARK_RING_START } from "./mark-geometry";
import { pointOnMarkPath } from "./mark-path";

/** The ghost's lag as a share of a lap — how the frames place it. */
const LAG = MARK_TRAIL_LAG_SECONDS / MARK_ORBIT_SECONDS;

/** Circles in document order: the core node, its ghost, then the travelling node. */
function circles(svg: string) {
  return [...svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="([\d.]+)"/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    r: Number(match[3]),
  }));
}

/** One circle by position, failing loudly if the drawing lost a node. */
function circleAt(svg: string, index: number) {
  const circle = circles(svg).at(index);
  if (!circle) throw new Error(`expected circle #${index} in the mark`);
  return circle;
}

/** Rounded the way the builders write coordinates. */
const written = (value: number) => Number(value.toFixed(3));

describe("animated mark", () => {
  it("draws the same ring as the static mark", () => {
    expect(markFrameSvg(0)).toContain(`<path d="${MARK_RING_PATH}"`);
  });

  it("keeps the agent at the core in every frame", () => {
    for (const t of [0, 0.3, 0.75, 1.4]) {
      const core = circleAt(markFrameSvg(t), 0);
      expect({ x: core.x, y: core.y, r: core.r }).toEqual({
        x: MARK_NODE.cx,
        y: MARK_NODE.cy,
        r: MARK_NODE.r,
      });
    }
  });

  it("puts the travelling node exactly on the path at phase t", () => {
    for (const t of [0, 0.125, 0.5, 0.9]) {
      const rider = circleAt(markFrameSvg(t), -1);
      const expected = pointOnMarkPath(t);
      expect(rider.x).toBe(written(expected.x));
      expect(rider.y).toBe(written(expected.y));
    }
  });

  it("trails a ghost a beat behind the node", () => {
    const svg = markFrameSvg(0.5);
    const trail = circleAt(svg, -2);
    const rider = circleAt(svg, -1);
    const expected = pointOnMarkPath(0.5 - LAG);

    expect(trail.r).toBe(MARK_TRAIL_RADIUS);
    expect(trail.x).toBe(written(expected.x));
    expect(trail.y).toBe(written(expected.y));
    // A ghost that sat on top of the node would read as neither.
    expect(Math.hypot(rider.x - trail.x, rider.y - trail.y)).toBeGreaterThan(1);
  });

  it("wraps with the clock", () => {
    expect(markFrameSvg(1)).toBe(markFrameSvg(0));
    expect(markFrameSvg(0.25)).toBe(markFrameSvg(1.25));
  });

  it("beats the core the moment a lap closes", () => {
    const rest = { core: MARK_NODE.r, halo: MARK_NODE.r, haloOpacity: 0 };

    // At rest for the whole lap, and again once the beat is over.
    for (const phase of [0.1, 0.35, 0.5, 0.9, 0.99, MARK_POP_END]) {
      expect(markPop(phase)).toEqual(rest);
    }

    const peak = markPop(MARK_POP_PEAK);
    expect(peak.core).toBeCloseTo(MARK_NODE.r * MARK_POP_CORE_SCALE, 6);
    expect(peak.haloOpacity).toBeCloseTo(MARK_POP_HALO_OPACITY, 6);
    expect(peak.halo).toBeGreaterThan(MARK_NODE.r);

    // One lap later the beat repeats exactly, and settles with no seam.
    expect(markPop(1 + MARK_POP_PEAK).core).toBeCloseTo(peak.core, 9);
    expect(markPop(1 + MARK_POP_END)).toEqual(rest);
    expect(markPop(1.5)).toEqual(markPop(0.5));
  });

  it("never overshoots the beat, and never dips below rest", () => {
    // Sampling at 1/6000 of a lap lands exactly on both keyframes.
    let minCore = Infinity;
    let maxCore = 0;
    let minHalo = Infinity;
    let minOpacity = Infinity;
    let maxOpacity = 0;

    for (let i = 0; i < 6000; i++) {
      const pop = markPop(i / 6000);
      minCore = Math.min(minCore, pop.core);
      maxCore = Math.max(maxCore, pop.core);
      minHalo = Math.min(minHalo, pop.halo);
      minOpacity = Math.min(minOpacity, pop.haloOpacity);
      maxOpacity = Math.max(maxOpacity, pop.haloOpacity);
    }

    expect(minCore).toBeCloseTo(MARK_NODE.r, 9);
    expect(maxCore).toBeCloseTo(MARK_NODE.r * MARK_POP_CORE_SCALE, 6);
    expect(minHalo).toBeCloseTo(MARK_NODE.r, 9);
    expect(maxOpacity).toBeCloseTo(MARK_POP_HALO_OPACITY, 6);
    expect(minOpacity).toBe(0);
  });

  it("draws the beat into the frames, and only during the beat", () => {
    // Rest frames carry one core circle and no halo.
    expect(circles(markFrameSvg(0.5))).toHaveLength(3);

    const during = markFrameSvg(MARK_POP_PEAK);
    expect(circles(during)).toHaveLength(4);
    expect(circleAt(during, 0).r).toBe(written(markPop(MARK_POP_PEAK).core));
    expect(circleAt(during, 1).r).toBe(written(markPop(MARK_POP_PEAK).halo));
  });

  it("keeps the drawn beat and the frames agreeing at every keyframe", () => {
    // The SMIL surfaces interpolate between these; the frames compute them. Same
    // numbers, or a viewer sees a different beat depending on the surface.
    expect(MARK_POP_MOTION.coreValues.split(";")).toEqual([
      String(MARK_NODE.r),
      String(written(MARK_NODE.r * MARK_POP_CORE_SCALE)),
      String(MARK_NODE.r),
      String(MARK_NODE.r),
    ]);
    expect(MARK_POP_MOTION.coreKeyTimes.split(";").map(Number)).toEqual([
      0,
      MARK_POP_PEAK,
      MARK_POP_END,
      1,
    ]);
    expect(MARK_POP_MOTION.haloRadiusValues.split(";").at(-1)).toBe(
      String(written(MARK_NODE.r * MARK_POP_HALO_SCALE)),
    );
    expect(MARK_POP_MOTION.haloOpacityValues.split(";").map(Number)[1]).toBe(MARK_POP_HALO_OPACITY);
    // Keyframes and splines must line up one-to-one, or SMIL drops the animation.
    expect(MARK_POP_MOTION.coreKeySplines.split(";")).toHaveLength(3);
    expect(MARK_POP_MOTION.haloRadiusKeySplines.split(";")).toHaveLength(2);
    expect(MARK_POP_MOTION.haloRadiusKeyTimes.split(";")).toHaveLength(
      MARK_POP_MOTION.haloRadiusValues.split(";").length,
    );

    expect(markAnimatedSvg()).toContain(`values="${MARK_POP_MOTION.coreValues}"`);
    expect(markAnimatedSvg()).toContain(`keySplines="${MARK_POP_MOTION.coreKeySplines}"`);
  });

  it("ships a standalone asset that animates along the same path", () => {
    const svg = markAnimatedSvg();

    // Both the node and its ghost animate, offset by the lag, and the core beats.
    expect(svg.match(/animateMotion/g)).toHaveLength(2);
    expect(svg.match(/<animate /g)).toHaveLength(3);
    expect(svg).toContain(`path="${MARK_MOTION_PATH}"`);
    expect(svg).toContain(`dur="${MARK_MOTION.duration}"`);
    // The ghost starts *late* so it trails rather than leads the node.
    expect(MARK_MOTION.trailDelay).toBe(`${MARK_TRAIL_LAG_SECONDS}s`);
    expect(svg).toContain(`begin="${MARK_MOTION.trailDelay}"`);
    expect(svg).toContain(`<path d="${MARK_RING_PATH}"`);

    // Without SMIL the node rests on the band rather than in a corner.
    // Document order: core, the beat, its halo, the ghost, the node.
    const core = circleAt(svg, 0);
    const trail = circleAt(svg, -2);
    const rider = circleAt(svg, -1);
    expect(core.x).toBe(MARK_NODE.cx);
    expect(core.y).toBe(MARK_NODE.cy);
    expect(trail.x).toBe(written(MARK_RING_START.x));
    expect(rider.x).toBe(written(MARK_RING_START.x));
    expect(rider.y).toBe(written(MARK_RING_START.y));

    expect(MARK_ORBIT_SECONDS).toBe(9);
    expect(MARK_MOTION.duration).toBe("9s");
  });
});
