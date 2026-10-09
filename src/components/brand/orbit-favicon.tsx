"use client";

import { useOrbitFavicon } from "./use-orbit-favicon";

/**
 * Drives the animated tab icon from anywhere in the tree.
 *
 * Renders nothing — the icon lives in the document head — so this is a switch a
 * server component can drop in and forget.
 */
export function OrbitFavicon({ active = true }: { active?: boolean }) {
  useOrbitFavicon(active);
  return null;
}
