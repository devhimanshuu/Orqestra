import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * The hero's line artwork.
 *
 * One structure, drawn once: horizontal lines spanning the full width of the
 * hero, laid out so their ends trace a rocket in profile — the tails pulled in
 * at the left, the noses tapering to a point at the right, the middle row the
 * longest and the brightest. The shape *is* the lines: nothing else is drawn,
 * so the structure stays readable at rest, as a plain stack of hairlines.
 *
 * It arrives rather than appears. The lines draw themselves in from the tail
 * toward the nose — the spine first and the edges after it — the flare at the
 * tip blooms as the last of them lands, one bright pulse races the length of
 * the spine, and only then does the travelling light fade up over the whole
 * structure (`.landing-line-draw`, `.landing-line-flare` and the keyframes in
 * `globals.css`; every one of them is switched off under reduced motion, which
 * sees the artwork exactly as drawn).
 *
 * Light runs along the lines after that: the drawing never moves, and a second
 * layer — the same paths, drawn from repeating gradients whose offsets travel
 * toward the nose — carries streaks down the whole width into the tip, each
 * streak led by a bright spark head. The seven phases run at seven paces
 * (`FLOW_PHASES`, `PHASE_PACE`) so the band never falls into a metronome, and
 * the streaks sit on the veil like the structure they ride.
 *
 * The full width is the point, but the hero's copy sits on the left, so a veil
 * (`.landing-line-veil`, in `globals.css`) holds the tail of the artwork down
 * to a texture under the text and lets it rise to full strength beneath the
 * nose, where the composition is empty. The flare at the tip is
 * `.landing-sweep-focus`, the group the pointer leans; the lines themselves are
 * `.landing-sweep-arcs`, and the travelling light rides them as
 * `.landing-sweep-flow-arcs` — the three hooks `interactive-sweep.tsx` writes
 * to, unchanged from the sweep this replaces.
 *
 * Coordinates are in a 1440×960 user space scaled with `slice`: the hero is
 * wider than it is tall at every size it is drawn for, so the width is what
 * survives and the height crops around the band.
 */

/** One pass of the travelling gradient, in seconds. A current, not a chase. */
const FLOW_SECONDS = 7;

/**
 * Exactly one period of the travelling gradient — its own span, `x1 − x2` —
 * so the loop closes without a seam.
 */
const FLOW_PERIOD = 720;

/**
 * How many distinct phases the light travels on, and how fast each one runs.
 * The lines are parallel and horizontal, so one shared gradient would put every
 * front in the same column: a single vertical bar sweeping the band. Rows take
 * their phase in turn (row `i` rides phase `i mod FLOW_PHASES`), and the phases
 * drift at slightly different paces, so adjacent rows never march together and
 * the pattern never quite repeats.
 */
const FLOW_PHASES = 7;
const PHASE_PACE: number[] = [1, 0.87, 1.13, 0.94, 1.06, 0.8, 1.2];

/** The user space the artwork is drawn in. */
const FIELD = { width: 1440, height: 960 } as const;

/** Where the band of lines sits, and how tall it is. */
const BAND = { center: 480, half: 170 } as const;

/** How many lines the structure is made of. */
const LINE_COUNT = 35;

/** The nose: where the centre row's tip lands, and how far the taper reaches back. */
const NOSE = { tip: 1400, depth: 640, power: 1.5 } as const;

/** The tails: the centre row starts at the very edge, the outer rows pull in. */
const TAIL_INSET = 150;

/** The entrance: how long each line takes to draw, and how long the whole thing holds. */
const DRAW = { seconds: 1.15, stagger: 0.55, flareDelay: 1.15, lightDelay: 1.4 } as const;

/** One ignition pulse, after the structure has landed. */
const IGNITION = { begin: 1.65, seconds: 1.25 } as const;

/**
 * The counter-flow: a slower, softer tide running back from the nose toward
 * the tail, opposite the main streaks. It is what keeps the band from reading
 * as one-directional traffic — the light *sloshes*, it does not merely run.
 * Longer period, lower opacity, only on every third row so it stays a texture
 * rather than a second subject.
 */
const BACKWASH_SECONDS = 13.5;
const BACKWASH_PERIOD = 1080;
const BACKWASH_PHASES = 3;
const BACKWASH_ROWS = 3; // every Nth row carries it

/** Stops of the backwash: a broad, dim swell rather than a hot front. */
const BACKWASH_STOPS = [
  [0, "#8b7bff", 0.5],
  [0.25, "#6a5ad0", 0.28],
  [0.55, "#4a3f9c", 0.1],
  [1, "#4a3f9c", 0],
] as const;

/**
 * The scan: a bright vertical front that periodically sweeps the whole band at
 * once, tail to nose, like a read head crossing a tape. It is one element —
 * a narrow gradient stripe translated in CSS — so it costs a composited move
 * rather than a redraw, and it only appears during its sweep (opacity gated in
 * the keyframes), resting invisible the rest of the time.
 */
const SCAN = { seconds: 16, width: 300, travel: FIELD.width + 300 } as const;

interface LineRow {
  /** `M tail … H nose` — the row, edge to nose, in user units. */
  d: string;
  /** −1…1 across the band: 0 is the centre row, ±1 the outermost. */
  offset: number;
  width: number;
  opacity: number;
  /** The row's own length, which is the dash it is drawn with. */
  length: number;
  /** When this row starts drawing: the spine first, the edges after it. */
  delay: number;
}

/**
 * The structure, computed once. Each row's ends are a function of how far it
 * sits from the centre: the tails close up as `offset²` (a shallow taper at the
 * left edge), the noses retreat along a `1.5` power (an ogive — blunt enough to
 * read as a body, sharp enough to read as a point).
 */
const LINE_ROWS: LineRow[] = Array.from({ length: LINE_COUNT }, (_, index) => {
  const offset = (index - (LINE_COUNT - 1) / 2) / ((LINE_COUNT - 1) / 2);
  const magnitude = Math.abs(offset);
  const tail = TAIL_INSET * offset * offset;
  const nose = NOSE.tip - NOSE.depth * Math.pow(magnitude, NOSE.power);
  const y = BAND.center + offset * BAND.half;

  return {
    d: `M ${tail.toFixed(1)} ${y.toFixed(1)} H ${nose.toFixed(1)}`,
    offset,
    width: 1.7 - 0.7 * magnitude,
    opacity: 0.3 + 0.45 * (1 - Math.pow(magnitude, 1.4)),
    length: nose - tail,
    delay: DRAW.stagger * Math.pow(magnitude, 1.3),
  };
});

/** The centre row, used for the ignition pulse. */
const SPINE_ROW: LineRow =
  LINE_ROWS.find((row) => row.offset === 0) ??
  ({ d: "", offset: 0, width: 1, opacity: 1, length: 0, delay: 0 } as LineRow);

/** Stops of one travelling streak: a bright front with a colour tail behind it. */
const STREAK_STOPS = [
  [0, "#ffffff", 1],
  [0.05, "#fff3dd", 0.85],
  [0.16, "#ffc857", 0.5],
  [0.34, "#ff6bb0", 0.22],
  [0.6, "#8b7bff", 0.06],
  [1, "#8b7bff", 0],
] as const;

/** Stops of the spark that leads a streak: a hot head, gone within a fortieth. */
const SPARK_STOPS = [
  [0, "#ffffff", 1],
  [0.015, "#fff6e6", 0.9],
  [0.04, "#ffd28a", 0.4],
  [0.08, "#ff9ad0", 0],
  [1, "#ff9ad0", 0],
] as const;

function TravellingGradient({
  id,
  phase,
  stops,
  duration,
  begin,
  repeat,
  period = FLOW_PERIOD,
  direction = 1,
}: {
  id: string;
  phase: number;
  stops: readonly (readonly [number, string, number])[];
  duration: number;
  begin?: string;
  repeat?: string;
  period?: number;
  /** +1 travels toward the nose; −1 washes back toward the tail. */
  direction?: 1 | -1;
}) {
  const shift = ((phase * period) / FLOW_PHASES + period) % period;
  const from = direction === 1 ? period : -period;
  return (
    <linearGradient
      id={id}
      gradientUnits="userSpaceOnUse"
      spreadMethod="repeat"
      x1={FIELD.width - shift}
      y1={BAND.center}
      x2={FIELD.width - period - shift}
      y2={BAND.center}
    >
      {stops.map(([offset, color, opacity]) => (
        <stop
          key={`${offset}`}
          offset={`${offset * 100}%`}
          stopColor={color}
          stopOpacity={opacity}
        />
      ))}
      {/*
       * The offset itself: one period along the flow (or against it, for the
       * backwash). It is a translate of the gradient, never of the artwork.
       */}
      <animateTransform
        attributeName="gradientTransform"
        type="translate"
        from="0 0"
        to={`${from} 0`}
        dur={`${duration.toFixed(2)}s`}
        begin={begin}
        repeatCount={repeat}
        fill={repeat === undefined ? "remove" : undefined}
      />
    </linearGradient>
  );
}

export function LineArt({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      {/*
       * The structure. The breath animation owns `transform` on this wrapper, so
       * the pointer's offset lands on the groups inside it instead of fighting
       * the wrapper for the same property.
       */}
      <div className="landing-sweep-breath landing-line-veil absolute inset-0 origin-right">
        <svg
          viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}
          preserveAspectRatio="xMidYMid slice"
          className="landing-sweep h-full w-full"
        >
          <defs>
            {[30, 7].map((deviation) => (
              <filter
                key={deviation}
                id={`orq-line-blur-${deviation}`}
                x="-60%"
                y="-60%"
                width="220%"
                height="220%"
                colorInterpolationFilters="sRGB"
              >
                <feGaussianBlur stdDeviation={deviation} />
              </filter>
            ))}

            {/*
             * The hue, running against the lines: amber at the nose, through
             * magenta, to violet at the tail — the same spectrum the page's
             * display type is filled with.
             */}
            <linearGradient
              id="orq-line-hue"
              gradientUnits="userSpaceOnUse"
              x1={FIELD.width}
              y1={BAND.center}
              x2={0}
              y2={BAND.center}
            >
              <stop offset="0" stopColor="#fff6e6" stopOpacity={1} />
              <stop offset="0.1" stopColor="#ffc857" stopOpacity={0.95} />
              <stop offset="0.3" stopColor="#ff6bb0" stopOpacity={0.85} />
              <stop offset="0.55" stopColor="#8b7bff" stopOpacity={0.8} />
              <stop offset="1" stopColor="#5b4bd6" stopOpacity={0.65} />
            </linearGradient>

            {/* the diffuse light the nose sits in */}
            <radialGradient id="orq-line-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#e8ecff" stopOpacity={0.2} />
              <stop offset="45%" stopColor="#8b7bff" stopOpacity={0.1} />
              <stop offset="100%" stopColor="#8b7bff" stopOpacity={0} />
            </radialGradient>

            {/* the caustic where every line's taper resolves */}
            <radialGradient id="orq-line-flare" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} />
              <stop offset="30%" stopColor="#ffe7c2" stopOpacity={0.5} />
              <stop offset="65%" stopColor="#ffc857" stopOpacity={0.16} />
              <stop offset="100%" stopColor="#ff6bb0" stopOpacity={0} />
            </radialGradient>
          </defs>

          {/*
           * The light's body, at the tip: a broad glow, the caustic, an
           * anamorphic streak across the axis and the core. The inner group
           * blooms once on arrival and then breathes; `landing-sweep-focus`
           * above it is the group the pointer moves — it leads, the lines trail
           * it (see `interactive-sweep.tsx`).
           */}
          <g className="landing-sweep-focus">
            <g
              className="landing-line-flare"
              style={{
                transformBox: "view-box",
                transformOrigin: `${NOSE.tip}px ${BAND.center}px`,
                animation: `landing-line-flare ${DRAW.seconds}s cubic-bezier(0.16, 1, 0.3, 1) ${DRAW.flareDelay}s both, landing-line-flare-pulse 6.5s ease-in-out ${DRAW.flareDelay + 1.2}s infinite`,
              }}
            >
              <ellipse
                cx={1330}
                cy={BAND.center}
                rx={360}
                ry={190}
                fill="url(#orq-line-glow)"
                filter="url(#orq-line-blur-30)"
              />
              <ellipse
                cx={NOSE.tip}
                cy={BAND.center}
                rx={150}
                ry={64}
                fill="url(#orq-line-flare)"
                filter="url(#orq-line-blur-30)"
              />
              <ellipse
                cx={1392}
                cy={BAND.center}
                rx={360}
                ry={5}
                fill="url(#orq-line-flare)"
                opacity={0.8}
                filter="url(#orq-line-blur-7)"
              />
              <ellipse
                cx={1414}
                cy={BAND.center}
                rx={70}
                ry={22}
                fill="url(#orq-line-flare)"
                filter="url(#orq-line-blur-7)"
              />
            </g>
          </g>

          {/* The structure: one hairline per row, drawn once and never moved. */}
          <g className="landing-sweep-arcs">
            {LINE_ROWS.map((row) => (
              <path
                key={row.d}
                d={row.d}
                fill="none"
                stroke="url(#orq-line-hue)"
                strokeWidth={row.width}
                strokeLinecap="round"
                opacity={row.opacity}
                className="landing-line-draw"
                style={
                  {
                    strokeDasharray: `${row.length}`,
                    strokeDashoffset: `${row.length}`,
                    "--landing-line-dash": `${row.length}`,
                    animation: `landing-line-draw ${DRAW.seconds}s cubic-bezier(0.16, 1, 0.3, 1) ${row.delay}s both`,
                  } as CSSProperties
                }
              />
            ))}
          </g>
        </svg>
      </div>

      {/*
       * The light travelling along those lines: the same paths, drawn from
       * gradients that move (see `PHASE_PACE` above) — a streak led by a spark,
       * and one bright ignition pulse down the spine after the structure has
       * landed. The layer's own opacity is the gate: it rests at zero and is
       * lifted once the lines have drawn themselves in.
       */}
      <div className="landing-sweep-breath landing-line-veil absolute inset-0 origin-right">
        <svg
          viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}
          preserveAspectRatio="xMidYMid slice"
          className="landing-sweep landing-sweep-flow h-full w-full"
          opacity={0}
        >
          <animate
            attributeName="opacity"
            to="1"
            begin={`${DRAW.lightDelay}s`}
            dur="1s"
            fill="freeze"
          />

          <defs>
            {Array.from({ length: FLOW_PHASES }, (_, phase) => (
              <TravellingGradient
                key={`orq-line-flow-${phase}`}
                id={`orq-line-flow-${phase}`}
                phase={phase}
                stops={STREAK_STOPS}
                duration={FLOW_SECONDS * (PHASE_PACE[phase % PHASE_PACE.length] ?? 1)}
                repeat="indefinite"
              />
            ))}
            {Array.from({ length: FLOW_PHASES }, (_, phase) => (
              <TravellingGradient
                key={`orq-line-spark-${phase}`}
                id={`orq-line-spark-${phase}`}
                phase={phase}
                stops={SPARK_STOPS}
                duration={FLOW_SECONDS * (PHASE_PACE[phase % PHASE_PACE.length] ?? 1)}
                repeat="indefinite"
              />
            ))}
            <TravellingGradient
              id="orq-line-ignite"
              phase={0}
              stops={SPARK_STOPS}
              duration={IGNITION.seconds}
              begin={`${IGNITION.begin}s`}
            />

            {/* the backwash — a slower tide running back from nose to tail */}
            {Array.from({ length: BACKWASH_PHASES }, (_, phase) => (
              <TravellingGradient
                key={`orq-line-backwash-${phase}`}
                id={`orq-line-backwash-${phase}`}
                phase={phase}
                stops={BACKWASH_STOPS}
                duration={BACKWASH_SECONDS * (0.9 + 0.14 * phase)}
                period={BACKWASH_PERIOD}
                direction={-1}
                repeat="indefinite"
              />
            ))}

            {/*
             * The scan: a bright vertical stripe that sweeps the whole band at
             * once, tail to nose, translating in CSS. Its gradient is fixed in
             * user space; only the element moves.
             */}
            <linearGradient
              id="orq-line-scan"
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={BAND.center}
              x2={SCAN.width}
              y2={BAND.center}
            >
              <stop offset="0" stopColor="#ffffff" stopOpacity={0} />
              <stop offset="0.5" stopColor="#fff3dd" stopOpacity={0.9} />
              <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
            </linearGradient>

            {/* the band the scan is allowed to sweep */}
            <clipPath id="orq-line-band">
              <rect
                x={0}
                y={BAND.center - BAND.half - 20}
                width={FIELD.width}
                height={BAND.half * 2 + 40}
              />
            </clipPath>
          </defs>

          {/* The pointer's offset is mirrored onto this group, so the light stays
              on its own lines when the visitor drives the hero. */}
          <g className="landing-sweep-flow-arcs">
            {LINE_ROWS.map((row, index) => (
              <g key={`flow-${row.d}`}>
                {/* the swell of the front around the line */}
                <path
                  d={row.d}
                  fill="none"
                  stroke={`url(#orq-line-flow-${index % FLOW_PHASES})`}
                  strokeWidth={row.width * 5}
                  strokeLinecap="round"
                  opacity={0.1}
                />
                {/* and the thread that runs along its centre */}
                <path
                  d={row.d}
                  fill="none"
                  stroke={`url(#orq-line-flow-${index % FLOW_PHASES})`}
                  strokeWidth={row.width}
                  strokeLinecap="round"
                  opacity={0.5}
                />
                {/* every other line also carries the spark that leads its streak */}
                {index % 2 === 0 ? (
                  <path
                    d={row.d}
                    fill="none"
                    stroke={`url(#orq-line-spark-${index % FLOW_PHASES})`}
                    strokeWidth={row.width * 1.3}
                    strokeLinecap="round"
                    opacity={0.85}
                  />
                ) : null}
              </g>
            ))}
            {/* the ignition: one pulse the length of the spine, after landing */}
            <path
              d={SPINE_ROW.d}
              fill="none"
              stroke="url(#orq-line-ignite)"
              strokeWidth={3}
              strokeLinecap="round"
              opacity={0.9}
            />

            {/*
             * Backwash: a soft tide running the other way on every third row.
             * It is what stops the band reading as one-directional traffic — the
             * light sloshes, it does not merely run. Broader and dimmer than
             * the streaks so it stays a texture, not a second subject.
             */}
            {LINE_ROWS.filter((_, index) => index % BACKWASH_ROWS === 1).map((row, i) => (
              <path
                key={`backwash-${row.d}`}
                d={row.d}
                fill="none"
                stroke={`url(#orq-line-backwash-${i % BACKWASH_PHASES})`}
                strokeWidth={row.width * 7}
                strokeLinecap="round"
                opacity={0.14}
              />
            ))}
          </g>

          {/*
           * Twinkle: individual rows flare briefly on their own phase, like a
           * star catching light. The delay is derived from the row index so the
           * shimmer never synchronises into a wave; reduced motion drops the
           * whole layer via the class in `globals.css`.
           */}
          <g className="landing-line-twinkle-layer">
            {LINE_ROWS.map((row, index) =>
              index % 3 === 0 ? (
                <path
                  key={`twinkle-${row.d}`}
                  d={row.d}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={row.width}
                  strokeLinecap="round"
                  opacity={0}
                  className="landing-line-twinkle"
                  style={
                    {
                      "--landing-twinkle-delay": `${(index * 0.37) % 6}s`,
                    } as CSSProperties
                  }
                />
              ) : null,
            )}
          </g>

          {/*
           * The scan: one bright front crossing the whole band at once, tail to
           * nose. A single translated stripe, so it is a composited move rather
           * than a redraw, and it rests invisible between sweeps.
           */}
          <g
            className="landing-line-scan"
            clipPath="url(#orq-line-band)"
            style={{ "--landing-scan-travel": `${SCAN.travel}px` } as CSSProperties}
          >
            <rect
              x={-SCAN.width}
              y={BAND.center - BAND.half - 20}
              width={SCAN.width}
              height={BAND.half * 2 + 40}
              fill="url(#orq-line-scan)"
              opacity={0.5}
            />
          </g>
        </svg>
      </div>
    </div>
  );
}
