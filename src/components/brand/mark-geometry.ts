/**
 * The Orqestra mark, as data.
 *
 * One source of truth for the geometry, shared by the in-app mark
 * (`OrqestraMark`) and the icon generator (`scripts/generate-icons.ts`) so the
 * favicon, the app tile and the drawn logo can never drift apart.
 *
 * Drawn on a 32-unit grid: the harness is the ring — a heavy squircle "O" whose
 * centreline spans 3.2 … 28.8 with 9.5-unit corner radii — and the agent is the
 * single node at its core.
 */

/** Side of the design grid. Everything below is in these units. */
export const MARK_GRID = 32;

/** Ring stroke weight. Heavy enough to hold at 16px, light enough to stay an "O". */
export const MARK_STROKE = 2.8;

/** Corner radius of the squircle. Roughly three quarters of the half-width. */
export const MARK_CORNER_RADIUS = 9.5;

/** Field corner radius — the app-icon squircle behind the mark on icons. */
export const MARK_FIELD_RADIUS = 7.5;

/** Trims float noise so derived geometry stays byte-stable across runs. */
const grid = (value: number) => Number(value.toFixed(3));

/**
 * Bounds of the *drawn* mark — the ring's centreline widened by half the stroke
 * on every side (1.8 … 30.2). Anything that scales the mark must use these, not
 * the centreline bounds, or the glyph lands off-centre inside its field.
 */
export const MARK_BOUNDS = {
  min: 3.2 - MARK_STROKE / 2,
  max: 28.8 + MARK_STROKE / 2,
} as const;

/** Width and height of {@link MARK_BOUNDS}, i.e. the mark's true extent. */
export const MARK_EXTENT = MARK_BOUNDS.max - MARK_BOUNDS.min;

/** The ring's centreline: the same squircle inset by half the stroke. */
export const MARK_EDGE_MIN = grid(MARK_BOUNDS.min + MARK_STROKE / 2);

export const MARK_EDGE_MAX = grid(MARK_BOUNDS.max - MARK_STROKE / 2);

/**
 * The harness ring: a closed squircle, no floating parts, no open caps.
 *
 * Built rather than transcribed so the drawn band, the CSS motion path and the
 * generated icons all start from the same numbers — a rider that follows this
 * path is guaranteed to sit on the band at any scale.
 *
 * It starts at the top edge's right end and runs clockwise.
 */
function buildRingPath(offset = { x: 0, y: 0 }): string {
  const min = MARK_EDGE_MIN;
  const max = MARK_EDGE_MAX;
  const r = MARK_CORNER_RADIUS;
  const x = (value: number) => grid(value + offset.x);
  const y = (value: number) => grid(value + offset.y);
  const arc = (toX: number, toY: number) => `A ${r} ${r} 0 0 1 ${x(toX)} ${y(toY)}`;
  return [
    `M ${x(max - r)} ${y(min)}`,
    arc(max, min + r),
    `V ${y(max - r)}`,
    arc(max - r, max),
    `H ${x(min + r)}`,
    arc(min, max - r),
    `V ${y(min + r)}`,
    arc(min + r, min),
    "Z",
  ].join(" ");
}

export const MARK_RING_PATH = buildRingPath();

/**
 * Where the ring path begins: the top edge's right end.
 *
 * This is also where the orbiting node rests, so the mark degrades to a node
 * sitting on its harness — never to a stray dot — wherever the motion is
 * unavailable (reduced motion, a renderer without SMIL).
 */
export const MARK_RING_START = {
  x: grid(MARK_EDGE_MAX - MARK_CORNER_RADIUS),
  y: MARK_EDGE_MIN,
} as const;

/**
 * The same ring, re-expressed around the origin.
 *
 * `animateMotion` composes *additively* with the animated shape's own position:
 * the motion point is added to the element's coordinates. Pairing this shifted
 * path with a node placed at {@link MARK_RING_START} therefore traces the ring's
 * centreline exactly (verified: max deviation 0.001 units), while an engine that
 * ignores the animation leaves the node parked on the band.
 */
export const MARK_MOTION_PATH = buildRingPath({ x: -MARK_RING_START.x, y: -MARK_RING_START.y });

/** The agent node, seated exactly at the ring's centre. */
export const MARK_NODE = { cx: 16, cy: 16, r: 2.2 } as const;

/** Product ink — the field colour of every raster/vector icon. */
export const MARK_FIELD_COLOR = "#08080A";

/** Ink of the mark itself on that field. */
export const MARK_INK_COLOR = "#FFFFFF";
