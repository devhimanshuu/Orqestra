/**
 * Generates the Orqestra icon set from the shared mark geometry, so the tab
 * icon, the home-screen tile and the logo drawn in the app can never drift:
 *
 *   src/app/icon.svg            vector favicon — dark field, mark centred
 *   src/app/favicon.ico         multi-size fallback (16/32/48, PNG frames)
 *   src/app/apple-icon.png      180px iOS tile (opaque, square — iOS masks it)
 *   public/orqestra-mark-animated.svg  the same mark in motion (SMIL)
 *
 * Run: pnpm exec tsx scripts/generate-icons.ts
 *
 * Rasterising goes through Playwright's Chromium (already a devDependency for
 * the e2e suite), so no image toolchain is required. Centring uses the mark's
 * *drawn* bounds — centreline plus half the stroke — not the centreline itself,
 * which is what silently pushes a glyph off-centre inside its field.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { markAnimatedSvg } from "../src/components/brand/mark-animation";
import {
  MARK_BOUNDS,
  MARK_EXTENT,
  MARK_FIELD_COLOR,
  MARK_GRID,
  MARK_INK_COLOR,
  MARK_NODE,
  MARK_RING_PATH,
  MARK_STROKE,
} from "../src/components/brand/mark-geometry";

const ROOT = join(import.meta.dirname, "..");
const APP = join(ROOT, "src", "app");
const PUBLIC = join(ROOT, "public");

/** Field corner radius on the grid — an app-icon squircle, not a circle. */
const FIELD_RADIUS = 7.5;

/** How much of the field the mark occupies, per destination. */
const VECTOR_GLYPH_RATIO = 0.806; // 25.8/32 → ~10% padding, like a platform icon
const ICO_GLYPH_RATIO = 0.806;
const APPLE_GLYPH_RATIO = 0.66; // iOS adds its own large mask; shrink to match

const ICO_SIZES = [16, 32, 48];

/** Trims float noise so generated files are byte-stable across runs. */
const n = (value: number) => String(Number(value.toFixed(3)));

interface IconOptions {
  /** Rendered size in pixels. */
  size: number;
  /** Fraction of the field the mark's drawn bounds occupy. */
  glyphRatio: number;
  /** Rounded app-icon field, or full-bleed square. */
  rounded: boolean;
  /** Explicit `width`/`height` attributes (omitted for a scalable favicon). */
  intrinsicSize?: boolean;
}

/**
 * A complete, self-contained icon document. The same builder draws the vector
 * favicon and the raster frames, which is what guarantees they agree.
 */
function iconSvg({ size, glyphRatio, rounded, intrinsicSize = true }: IconOptions): string {
  const scale = (MARK_GRID * glyphRatio) / MARK_EXTENT;
  const margin = (MARK_GRID - MARK_EXTENT * scale) / 2;
  const translate = margin - scale * MARK_BOUNDS.min;
  const transform = `translate(${n(translate)} ${n(translate)}) scale(${n(scale)})`;
  const sizeAttrs = intrinsicSize ? ` width="${size}" height="${size}"` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_GRID} ${MARK_GRID}"${sizeAttrs} role="img" aria-label="Orqestra">
  <rect width="${MARK_GRID}" height="${MARK_GRID}"${rounded ? ` rx="${FIELD_RADIUS}"` : ""} fill="${MARK_FIELD_COLOR}" />
  <g transform="${transform}" fill="none" stroke="${MARK_INK_COLOR}" stroke-width="${MARK_STROKE}" stroke-linejoin="round">
    <path d="${MARK_RING_PATH}" />
    <circle cx="${MARK_NODE.cx}" cy="${MARK_NODE.cy}" r="${MARK_NODE.r}" fill="${MARK_INK_COLOR}" stroke="none" />
  </g>
</svg>
`;
}

/** Packs PNG frames into a .ico container (PNG-in-ICO is understood everywhere). */
function buildIco(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries: Buffer[] = [];
  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0); // width (0 = 256)
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1); // height
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += frame.png.length;
  }

  return Buffer.concat([header, ...entries, ...frames.map((f) => f.png)]);
}

/** Reads PNG dimensions straight out of the IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  const isPng =
    png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    png.subarray(12, 16).toString("ascii") === "IHDR";
  if (!isPng) throw new Error("payload is not a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function rasterise(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  options: IconOptions,
): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: { width: options.size, height: options.size },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  // `omitBackground` keeps the rounding of the field, not the page, in charge
  // of transparency; the field itself covers the full square when unrounded.
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${iconSvg(options)}`,
  );
  const png = await page.locator("svg").screenshot({ omitBackground: true });
  await context.close();
  return png;
}

async function main() {
  const browser = await chromium.launch();
  try {
    const vector = iconSvg({
      size: MARK_GRID,
      glyphRatio: VECTOR_GLYPH_RATIO,
      rounded: true,
      intrinsicSize: false,
    });
    writeFileSync(join(APP, "icon.svg"), vector, "utf8");

    // The animated mark is written verbatim from the app's own builder: the file
    // that plays in an <img> is the same figure the app draws.
    mkdirSync(PUBLIC, { recursive: true });
    const animated = markAnimatedSvg();
    writeFileSync(join(PUBLIC, "orqestra-mark-animated.svg"), animated, "utf8");

    const frames: { size: number; png: Buffer }[] = [];
    for (const size of ICO_SIZES) {
      const png = await rasterise(browser, { size, glyphRatio: ICO_GLYPH_RATIO, rounded: true });
      const dims = pngSize(png);
      if (dims.width !== size || dims.height !== size) {
        throw new Error(`frame ${size}px rendered at ${dims.width}×${dims.height}`);
      }
      frames.push({ size, png });
    }
    const ico = buildIco(frames);
    writeFileSync(join(APP, "favicon.ico"), ico);

    const APPLE_SIZE = 180;
    const apple = await rasterise(browser, {
      size: APPLE_SIZE,
      glyphRatio: APPLE_GLYPH_RATIO,
      rounded: false,
    });
    if (pngSize(apple).width !== APPLE_SIZE) throw new Error("apple icon has the wrong size");
    writeFileSync(join(APP, "apple-icon.png"), apple);

    // Read the .ico back the way a browser would, and report what was written.
    const count = ico.readUInt16LE(4);
    const readBack = Array.from({ length: count }, (_, i) => {
      const entry = 6 + i * 16;
      const bytes = ico.readUInt32LE(entry + 8);
      const start = ico.readUInt32LE(entry + 12);
      const frame = pngSize(ico.subarray(start, start + bytes));
      return `${frame.width}×${frame.height} (${bytes}B)`;
    });
    console.log(`icon.svg          ${vector.length}B`);
    console.log(`favicon.ico       ${ico.length}B — ${count} frames: ${readBack.join(", ")}`);
    console.log(`apple-icon.png    ${apple.length}B — ${APPLE_SIZE}px`);
    console.log(`orqestra-mark-animated.svg  ${animated.length}B`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
