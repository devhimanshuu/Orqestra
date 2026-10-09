import { describe, expect, it } from "vitest";
import {
  SWEEP_DIM,
  SWEEP_REST,
  SWEEP_TRAVEL,
  advance,
  approach,
  sweepSettled,
  sweepTarget,
} from "./sweep-motion";

describe("sweep response", () => {
  it("rests as drawn — full strength, no offset, at the focus", () => {
    const atFocus = sweepTarget(1, 0);
    expect(atFocus).toEqual({ x: SWEEP_TRAVEL.x, y: 0, glow: 1, lit: 1 });
    expect(SWEEP_REST).toEqual({ x: 0, y: 0, glow: 1, lit: 1 });
  });

  it("dims no further than the far corner", () => {
    const far = sweepTarget(-1, -1);
    expect(far.x).toBe(-SWEEP_TRAVEL.x);
    expect(far.y).toBe(-SWEEP_TRAVEL.y);
    expect(far.glow).toBeCloseTo(SWEEP_DIM.glow, 9);
    expect(far.lit).toBeCloseTo(SWEEP_DIM.lit, 9);
  });

  it("never brightens past the drawn artwork, anywhere in the hero", () => {
    for (let x = -1; x <= 1; x += 0.05) {
      for (let y = -1; y <= 1; y += 0.05) {
        const state = sweepTarget(x, y);
        expect(state.glow).toBeLessThanOrEqual(1);
        expect(state.lit).toBeLessThanOrEqual(1);
        expect(state.glow).toBeGreaterThanOrEqual(SWEEP_DIM.glow);
        expect(state.lit).toBeGreaterThanOrEqual(SWEEP_DIM.lit);
        expect(Math.abs(state.x)).toBeLessThanOrEqual(SWEEP_TRAVEL.x);
        expect(Math.abs(state.y)).toBeLessThanOrEqual(SWEEP_TRAVEL.y);
      }
    }
  });

  it("firms up as the pointer closes on the focal point", () => {
    let closer = sweepTarget(-1, 0);
    for (const offset of [-0.6, -0.2, 0.2, 0.6, 1]) {
      const next = sweepTarget(offset, 0);
      expect(next.glow).toBeGreaterThan(closer.glow);
      expect(next.lit).toBeGreaterThan(closer.lit);
      closer = next;
    }
  });

  it("clamps pointers that leave the hero", () => {
    expect(sweepTarget(4, -9)).toEqual(sweepTarget(1, -1));
    expect(sweepTarget(-3, 2)).toEqual(sweepTarget(-1, 1));
  });

  it("eases without overshooting", () => {
    let value = 0;
    let previous = -1;
    for (let frame = 0; frame < 240; frame++) {
      value = approach(value, 100, 1 / 60);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(100);
      previous = value;
    }
    expect(value).toBeCloseTo(100, 6);
  });

  it("eases at the same rate whatever the frame rate", () => {
    // The same second of wall clock must land in the same place at 144, 60 and
    // 20 frames a second — otherwise the light moves faster on faster machines.
    const after = (fps: number) => {
      let value = 0;
      const steps = Math.round(fps);
      for (let i = 0; i < steps; i++) value = approach(value, 100, 1 / fps);
      return value;
    };

    const fast = after(144);
    const normal = after(60);
    const slow = after(20);
    expect(normal).toBeCloseTo(fast, 6);
    expect(slow).toBeCloseTo(fast, 6);
  });

  it("ignores a step that has no time in it", () => {
    expect(approach(12, 100, 0)).toBe(12);
    expect(approach(12, 100, -1)).toBe(12);
  });

  it("knows when it has arrived", () => {
    expect(sweepSettled(SWEEP_REST, SWEEP_REST)).toBe(true);
    expect(sweepSettled({ ...SWEEP_REST, x: 2 }, SWEEP_REST)).toBe(false);
    expect(sweepSettled({ ...SWEEP_REST, glow: 0.9 }, SWEEP_REST)).toBe(false);

    // A whole state, eased for a second, is settled — and the frame that
    // follows it moves less than a stray pixel, so the loop can stop there
    // without the light visibly snapping.
    const target = sweepTarget(-1, 0.5);
    let state = SWEEP_REST;
    for (let i = 0; i < 60; i++) state = advance(state, target, 1 / 60);
    expect(sweepSettled(state, target)).toBe(true);

    const next = advance(state, target, 1 / 60);
    expect(sweepSettled(next, target)).toBe(true);
    expect(Math.abs(next.x - state.x)).toBeLessThan(0.4);
    expect(Math.abs(next.glow - state.glow)).toBeLessThan(0.004);
  });
});
