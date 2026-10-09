"use client";

import { useEffect } from "react";
import { FAVICON_FRAME_MS, MARK_ORBIT_SECONDS, markFrameSvg } from "./mark-animation";

/**
 * Puts the mark in motion in the browser tab while `active`.
 *
 * Chrome renders an SVG favicon's first frame and stops — it does not run SMIL
 * or CSS inside an icon — so the icon is animated the only way that works
 * everywhere: by handing the browser a new frame, as a data URL, a handful of
 * times a second. The frames come from the same geometry as the drawn mark, so
 * the tab and the logo are the same figure at different sizes.
 *
 * The hook borrows the icon link Next already declared rather than adding a
 * second one (two `rel="icon"` links would leave the browser to guess), claims
 * `sizes="any"` while it drives it, and restores the link untouched afterwards.
 *
 * It stays still when the tab is hidden (there is no icon to animate) and when
 * the reader asked for reduced motion — the same courtesy the drawn mark pays.
 */
export function useOrbitFavicon(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"][type="image/svg+xml"]');
    if (!link) return;

    const previousHref = link.getAttribute("href");
    const previousSizes = link.getAttribute("sizes");
    link.setAttribute("sizes", "any");

    let timer: number | undefined;
    let startedAt = performance.now();

    const paint = (now: number) => {
      const phase = ((now - startedAt) / (MARK_ORBIT_SECONDS * 1000)) % 1;
      link.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(markFrameSvg(phase))}`);
    };

    const start = () => {
      if (timer !== undefined) return;
      startedAt = performance.now();
      paint(startedAt);
      timer = window.setInterval(() => paint(performance.now()), FAVICON_FRAME_MS);
    };

    const stop = () => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
      if (previousHref === null) link.removeAttribute("href");
      else link.setAttribute("href", previousHref);
      if (previousSizes === null) link.removeAttribute("sizes");
      else link.setAttribute("sizes", previousSizes);
    };
  }, [active]);
}
