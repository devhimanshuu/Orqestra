"use client";

import { useEffect, useRef } from "react";
import { Aurora } from "./primitives";
import {
  ARCS_TRAIL,
  SWEEP_REST,
  advance,
  sweepSettled,
  sweepTarget,
  type SweepState,
} from "./sweep-motion";

/**
 * The hero's sweep, answering the pointer.
 *
 * The light leans toward the pointer and firms up as the pointer approaches its
 * focal point; stop moving and it eases back to the resting shape, exactly as
 * drawn. The response is written as a `transform` and an `opacity` on the two
 * groups of the artwork, so every frame of the interaction is a composited
 * change rather than a re-render.
 *
 * Two things about the writing are deliberate, and both are measurable on this
 * page. The offset goes straight onto the groups instead of through a custom
 * property on their ancestor: these are a dozen Gaussian-blurred shapes, and a
 * custom property up the tree invalidates style for all of them every frame —
 * several times the cost of setting the two transforms here. And the groups are
 * *promoted* (`landing-sweep-hosting`) only while the light is being driven,
 * because re-rastering that blur unpromoted costs several times the frame time,
 * while an unpromoted idle sweep costs nothing.
 *
 * Pointer events are *coalesced*: a move records where the pointer is and asks
 * for a frame, and the frame is what measures, eases and paints. A high-polling
 * mouse therefore still costs one update per frame rather than one per event,
 * and the light moves at the display's rate rather than the device's.
 *
 * The mapping, the trail and the easing live in `./sweep-motion` (pure,
 * unit-tested); this file is only the plumbing: listen, step, paint, let go.
 *
 * Deliberate omissions: touch pointers are ignored (a finger dragging the light
 * around is not the effect), the light rests when the pointer is outside the
 * hero, and reduced motion means no listener is ever attached — the mark of a
 * visitor who wants stillness is honoured before anything is drawn.
 */

/** A pointer that stands still for this long hands the light back to rest. */
const IDLE_MS = 260;

/** How far outside the hero the pointer may stray before the light lets go. */
const SLACK = 0.12;

/** Longest step the easing will take, so a paused tab cannot fling the light. */
const MAX_STEP_SECONDS = 0.1;

export function InteractiveSweep() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const focus = element.querySelector<SVGGElement>(".landing-sweep-focus");
    const arcs = element.querySelector<SVGGElement>(".landing-sweep-arcs");
    if (focus === null || arcs === null) return;

    // Everything drawn with the beams' offset: the arcs themselves, and the light
    // flowing along them, which must stay on its own beams when they lean.
    const arcLayers = [arcs, element.querySelector<SVGGElement>(".landing-sweep-flow-arcs")].filter(
      (layer): layer is SVGGElement => layer !== null,
    );

    let pointer: { x: number; y: number } | null = null;
    let target: SweepState = SWEEP_REST;
    let current: SweepState = SWEEP_REST;
    let frame: number | undefined;
    let idle: number | undefined;
    let lastStep = 0;
    let painted = false;
    let hosting = false;

    const paint = (state: SweepState) => {
      focus.style.transform = `translate(${state.x.toFixed(2)}px, ${state.y.toFixed(2)}px)`;
      focus.style.opacity = state.glow.toFixed(4);
      // The beams trail the focus at a fraction of the distance: parallax, so
      // the light leans toward the pointer instead of sliding off its own arcs.
      const trailX = state.x * ARCS_TRAIL;
      const trailY = state.y * ARCS_TRAIL;
      for (const layer of arcLayers) {
        layer.style.transform = `translate(${trailX.toFixed(2)}px, ${trailY.toFixed(2)}px)`;
        layer.style.opacity = state.lit.toFixed(4);
      }
      painted = true;
    };

    /** Hand the artwork back exactly as drawn: no transform, no dimmer. */
    const rest = () => {
      if (!painted) return;
      for (const property of ["transform", "opacity"]) {
        focus.style.removeProperty(property);
        for (const layer of arcLayers) layer.style.removeProperty(property);
      }
      painted = false;
    };

    /** Only touch the class when it changes — a needless write re-invalidates style. */
    const promote = (on: boolean) => {
      if (on === hosting) return;
      hosting = on;
      element.classList.toggle("landing-sweep-hosting", on);
    };

    /** Where the light wants to be, given where the pointer was last seen. */
    const targetFor = (): SweepState => {
      if (pointer === null) return SWEEP_REST;

      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return SWEEP_REST;

      const nx = ((pointer.x - rect.left) / rect.width) * 2 - 1;
      const ny = ((pointer.y - rect.top) / rect.height) * 2 - 1;
      return Math.abs(nx) > 1 + SLACK || Math.abs(ny) > 1 + SLACK
        ? SWEEP_REST
        : sweepTarget(nx, ny);
    };

    /** One eased step. Returns whether more of them are needed. */
    const step = (now: number): boolean => {
      const elapsed = lastStep === 0 ? 1 / 60 : Math.min(MAX_STEP_SECONDS, (now - lastStep) / 1000);
      lastStep = now;

      target = targetFor();
      current = advance(current, target, elapsed);
      paint(current);
      return !sweepSettled(current, target);
    };

    const tick = (now: number) => {
      frame = undefined;
      if (step(now)) {
        frame = requestAnimationFrame(tick);
        return;
      }
      // Settled, and nobody driving: the artwork goes back to being drawn, and
      // its groups stop holding layers.
      if (pointer === null) {
        rest();
        promote(false);
      }
    };

    const wake = () => {
      if (frame === undefined) frame = requestAnimationFrame(tick);
    };

    const letGo = () => {
      pointer = null;
      target = SWEEP_REST;
      wake();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY };
      promote(true);
      window.clearTimeout(idle);
      idle = window.setTimeout(letGo, IDLE_MS);
      wake();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", letGo);
    window.addEventListener("blur", letGo);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", letGo);
      window.removeEventListener("blur", letGo);
      window.clearTimeout(idle);
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.classList.remove("landing-sweep-hosting");
      rest();
    };
  }, []);

  return (
    <div
      ref={host}
      aria-hidden="true"
      data-sweep="hero"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <Aurora />
    </div>
  );
}
