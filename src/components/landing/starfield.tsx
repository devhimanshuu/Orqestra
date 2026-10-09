"use client";

import { useEffect, useRef } from "react";

/**
 * Animated star field.
 *
 * A canvas of small stars that twinkle on individual sine phases and drift very
 * slowly — the base layer of the landing page's dark surface. It is DPR-aware,
 * pauses when the tab is hidden, redraws once (statically) for visitors who
 * prefer reduced motion, and stops entirely on unmount.
 *
 * The star layout comes from a seeded PRNG so server and client agree and a
 * reload looks the same instead of reshuffling every paint.
 */

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  x: number;
  y: number;
  radius: number;
  brightness: number;
  phase: number;
  drift: number;
  warmth: number;
}

const SEED = 20_261_008;

export function Starfield({
  className,
  density = 0.00022,
  speed = 0.9,
  maxRadius = 1.5,
  tint = true,
}: {
  className?: string;
  /** Stars per CSS pixel² — scaled by the canvas area. */
  density?: number;
  /** Twinkle speed multiplier. */
  speed?: number;
  maxRadius?: number;
  /** Mix a few coloured stars into the white ones. */
  tint?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const random = mulberry32(SEED);
    let stars: Star[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let elapsed = 0;
    let last = 0;

    const build = (): void => {
      const count = Math.max(40, Math.round(width * height * density));
      stars = Array.from({ length: count }, () => ({
        x: random() * width,
        y: random() * height,
        radius: 0.35 + random() * (maxRadius - 0.35),
        brightness: 0.25 + random() * 0.75,
        phase: random() * Math.PI * 2,
        drift: 0.6 + random() * 2.4,
        warmth: random(),
      }));
    };

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
      if (reduceMotion) {
        draw(0);
      }
    };

    const draw = (time: number): void => {
      context.clearRect(0, 0, width, height);
      for (const star of stars) {
        const twinkle = 0.45 + 0.55 * Math.sin(time * speed + star.phase);
        const alpha = Math.max(0, Math.min(1, star.brightness * twinkle));
        // Stars drift downward at their own speed (the reference's star field
        // moves too — that slow travel is the hero's sense of life), wrapping
        // around the canvas edge so the pattern never runs out.
        const y = reduceMotion ? star.y : (star.y + time * star.drift * 1.25) % height;
        context.beginPath();
        context.fillStyle =
          tint && star.warmth > 0.94
            ? `rgba(190, 205, 255, ${alpha})`
            : tint && star.warmth < 0.05
              ? `rgba(255, 226, 190, ${alpha})`
              : `rgba(255, 255, 255, ${alpha})`;
        context.arc(star.x, y, star.radius, 0, Math.PI * 2);
        context.fill();
      }
    };

    const loop = (timestamp: number): void => {
      const delta = last === 0 ? 0 : Math.min(48, timestamp - last);
      last = timestamp;
      elapsed += delta * 0.001;
      draw(elapsed);
      frame = window.requestAnimationFrame(loop);
    };

    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const onVisibility = (): void => {
      if (reduceMotion) {
        return;
      }
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
      } else if (frame === 0) {
        frame = window.requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    if (!reduceMotion) {
      frame = window.requestAnimationFrame(loop);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [density, speed, maxRadius, tint]);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
