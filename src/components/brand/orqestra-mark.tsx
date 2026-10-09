import {
  MARK_GRID,
  MARK_NODE,
  MARK_RING_PATH,
  MARK_RING_START,
  MARK_STROKE,
} from "./mark-geometry";
import {
  MARK_MOTION,
  MARK_POP_MOTION,
  MARK_RIDER_RADIUS,
  MARK_STROKE_FRACTION,
  MARK_TRAIL_OPACITY,
  MARK_TRAIL_RADIUS,
} from "./mark-animation";
import { cn } from "@/lib/utils";

/**
 * The Orqestra mark.
 *
 * The harness is the ring — a heavy squircle "O" that encloses and holds — and
 * the agent is the single node at its core: one glyph, nothing hanging off the
 * silhouette, nothing fine enough to clog, so it reads as deliberately at 96px
 * as it does in a 16px tab (where the node melts into the counter).
 *
 * `animated` sends the node out along the band: one slow lap of the harness with
 * a faint ghost behind it for direction, and a beat at the core as each lap
 * closes. It is drawn with SMIL — the cheapest way to move something along a
 * path — and the node's resting place is where the path starts, so a renderer
 * that ignores SMIL (or a reader who asked for reduced motion, which hides the
 * travelling parts and the beat outright) still sees the node sitting on the
 * harness with its core at rest.
 *
 * Monochrome (`currentColor`), gradient-free. Geometry and motion live in
 * `./mark-geometry` and `./mark-animation`, shared with the icon generator and
 * the animated tab icon so every surface draws the same figure.
 */
export function OrqestraMark({
  className,
  animated = false,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`}
      aria-hidden="true"
      className={cn("h-8 w-8", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={MARK_STROKE}
      strokeLinejoin="round"
    >
      <path d={MARK_RING_PATH} />
      <circle
        cx={MARK_NODE.cx}
        cy={MARK_NODE.cy}
        r={MARK_NODE.r}
        fill="currentColor"
        stroke="none"
      />
      {animated ? (
        <>
          {/*
            The beat: an overlay at the core that swells as each lap closes, and
            the ring of light it leaves behind. Kept as separate elements — the
            core underneath never moves — so CSS can switch the beat off for a
            reader who asked for reduced motion without touching the mark's
            resting shape. `MARK_POP_MOTION` is the same curve the generated
            tab icon and asset draw, held to it by the tests.
          */}
          <circle
            className="brand-mark-pop"
            cx={MARK_NODE.cx}
            cy={MARK_NODE.cy}
            r={MARK_NODE.r}
            fill="currentColor"
            stroke="none"
          >
            <animate
              attributeName="r"
              dur={MARK_POP_MOTION.duration}
              values={MARK_POP_MOTION.coreValues}
              keyTimes={MARK_POP_MOTION.coreKeyTimes}
              keySplines={MARK_POP_MOTION.coreKeySplines}
              calcMode="spline"
              repeatCount="indefinite"
            />
          </circle>
          <circle
            className="brand-mark-halo"
            cx={MARK_NODE.cx}
            cy={MARK_NODE.cy}
            r={MARK_NODE.r}
            fill="none"
            stroke="currentColor"
            strokeWidth={MARK_STROKE * MARK_STROKE_FRACTION}
            opacity={0}
          >
            <animate
              attributeName="r"
              dur={MARK_POP_MOTION.duration}
              values={MARK_POP_MOTION.haloRadiusValues}
              keyTimes={MARK_POP_MOTION.haloRadiusKeyTimes}
              keySplines={MARK_POP_MOTION.haloRadiusKeySplines}
              calcMode="spline"
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              dur={MARK_POP_MOTION.duration}
              values={MARK_POP_MOTION.haloOpacityValues}
              keyTimes={MARK_POP_MOTION.haloOpacityKeyTimes}
              keySplines={MARK_POP_MOTION.haloOpacityKeySplines}
              calcMode="spline"
              repeatCount="indefinite"
            />
          </circle>
          <circle
            className="brand-mark-ghost"
            cx={MARK_RING_START.x}
            cy={MARK_RING_START.y}
            r={MARK_TRAIL_RADIUS}
            fill="currentColor"
            stroke="none"
            opacity={MARK_TRAIL_OPACITY}
          >
            <animateMotion
              dur={MARK_MOTION.duration}
              begin={MARK_MOTION.trailDelay}
              repeatCount="indefinite"
              path={MARK_MOTION.path}
            />
          </circle>
          <circle
            className="brand-mark-rider"
            cx={MARK_RING_START.x}
            cy={MARK_RING_START.y}
            r={MARK_RIDER_RADIUS}
            fill="currentColor"
            stroke="none"
          >
            <animateMotion
              dur={MARK_MOTION.duration}
              repeatCount="indefinite"
              path={MARK_MOTION.path}
            />
          </circle>
        </>
      ) : null}
    </svg>
  );
}
