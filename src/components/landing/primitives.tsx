import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Landing-page primitives.
 *
 * Small, presentation-only pieces shared by the marketing page: the iridescent
 * background, the section rhythm (mono eyebrow → display title → lede), framed
 * panels, mono chips, the capability marquee and terminal blocks. Server
 * components on purpose — none of them need state.
 */

/*
 * Iridescent sweep.
 *
 * The reference's hero light is a *lens*: two arcs that converge to a bright
 * focal point where they meet the right edge, with chromatic fringing along
 * their edges and a diffuse glow between them. It does not swing or rotate —
 * only the star field over it moves — so this is drawn once as SVG (blurred
 * strokes, screen-blended) and the wrapper gets at most a barely perceptible
 * breathe. Animating the bands themselves made them scissor across the hero,
 * which is what made it look wrong.
 *
 * Coordinates are in a 1440×900 user space, scaled with `slice` so the sweep
 * always reaches the right edge on wide screens.
 */

interface SweepPath {
  d: string;
  /** Outer arcs carry the full halo stack; inner arcs only the band + core. */
  weight: "outer" | "inner";
  /** Which side of the spectrum this arc's fringing leans to. */
  fringe: "warm" | "cool";
}

const SWEEP_FOCUS = { x: 1500, y: 470 };

/*
 * The flowing light.
 *
 * The arcs are drawn once and never move, but light travelling *along* them
 * reads as energy arriving at the focal point — so the beams are drawn a second
 * time, on a layer of their own, from repeating gradients whose offset is
 * animated toward the focus. The paths are the same paths: only the gradients
 * travel, and the drawing underneath is untouched.
 *
 * The separate layer is the point, and it was measured. Offsetting a gradient on
 * the artwork's own strokes repaints their blurs with it — about five times the
 * frame cost of the whole page — while the same animation on a light layer costs
 * roughly half a frame. That layer rides the same `slice` scaling, the same
 * breathe and the same pointer offset as the beams beneath, so it registers with
 * them exactly.
 */

/** One pass of the gradient, in seconds. A current, not a chase. */
const FLOW_SECONDS = 7;

/** Exactly one period of the gradient — its own span — so the loop has no seam. */
const FLOW_PERIOD = SWEEP_FOCUS.x - 780;

/**
 * Bright front, fading tail: light entering the beam and running to the focus.
 * The body is the broad swell inside the beams, the line is the crisp thread.
 */
const FLOW_GRADIENTS = [
  {
    id: "orq-flow-body",
    stops: [
      [0, "#ffffff", 0.9],
      [0.2, "#e2e7ff", 0.42],
      [0.6, "#9b91ff", 0.1],
      [1, "#9b91ff", 0],
    ],
  },
  {
    id: "orq-flow-line",
    stops: [
      [0, "#ffffff", 1],
      [0.3, "#d8e2ff", 0.5],
      [1, "#a99cff", 0],
    ],
  },
] as const;

const SWEEP_PATHS: SweepPath[] = [
  // upper lens — shallow arc, softest at its left tail
  { d: "M 1500 470 C 1336 302 1096 216 726 182", weight: "outer", fringe: "warm" },
  { d: "M 1500 470 C 1392 382 1284 330 1092 312", weight: "inner", fringe: "warm" },
  // lower lens
  { d: "M 1500 470 C 1336 638 1092 704 740 726", weight: "outer", fringe: "cool" },
  { d: "M 1500 470 C 1392 558 1284 610 1092 630", weight: "inner", fringe: "cool" },
];

export function Aurora({ className, flip = false }: { className?: string; flip?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      {/*
       * The breathe animation owns `transform` on this wrapper, so the optional
       * vertical flip lives on the SVG itself instead of fighting it.
       */}
      <div className="landing-sweep-breath absolute inset-0 origin-right">
        <svg
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
          className={cn("landing-sweep h-full w-full", flip === true && "-scale-y-100")}
        >
          <defs>
            {[80, 38, 30, 7].map((deviation) => (
              <filter
                key={deviation}
                id={`orq-blur-${deviation}`}
                x="-60%"
                y="-60%"
                width="220%"
                height="220%"
                colorInterpolationFilters="sRGB"
              >
                <feGaussianBlur stdDeviation={deviation} />
              </filter>
            ))}

            {[
              {
                id: "orq-fade-white",
                stops: [
                  [0, "#ffffff", 1],
                  [0.14, "#f4f8ff", 0.8],
                  [0.42, "#d7ddff", 0.26],
                  [0.72, "#9b91ff", 0.08],
                  [1, "#9b91ff", 0],
                ],
              },
              {
                id: "orq-fade-color",
                stops: [
                  [0, "#fff2c9", 0.85],
                  [0.18, "#ff9ad5", 0.42],
                  [0.5, "#a99cff", 0.22],
                  [1, "#a99cff", 0],
                ],
              },
              {
                id: "orq-fade-cyan",
                stops: [
                  [0, "#d6f6ff", 0.9],
                  [0.32, "#7fd8ff", 0.34],
                  [1, "#7fd8ff", 0],
                ],
              },
              {
                id: "orq-fade-magenta",
                stops: [
                  [0, "#ffdcf0", 0.9],
                  [0.32, "#ff8fd0", 0.34],
                  [1, "#ff8fd0", 0],
                ],
              },
              {
                id: "orq-fade-amber",
                stops: [
                  [0, "#fff0c2", 0.9],
                  [0.32, "#ffc46b", 0.32],
                  [1, "#ffc46b", 0],
                ],
              },
              {
                id: "orq-fade-violet",
                stops: [
                  [0, "#e6e2ff", 0.9],
                  [0.32, "#a99cff", 0.32],
                  [1, "#a99cff", 0],
                ],
              },
            ].map((gradient) => (
              <linearGradient
                key={gradient.id}
                id={gradient.id}
                gradientUnits="userSpaceOnUse"
                x1={SWEEP_FOCUS.x}
                y1={SWEEP_FOCUS.y}
                x2={780}
                y2={SWEEP_FOCUS.y}
              >
                {gradient.stops.map(([offset, color, opacity]) => (
                  <stop
                    key={`${gradient.id}-${offset}`}
                    offset={`${Number(offset) * 100}%`}
                    stopColor={String(color)}
                    stopOpacity={Number(opacity)}
                  />
                ))}
              </linearGradient>
            ))}

            <radialGradient id="orq-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#e8ecff" stopOpacity="0.16" />
              <stop offset="45%" stopColor="#9f8cff" stopOpacity="0.07" />
              <stop offset="100%" stopColor="#7c6cff" stopOpacity="0" />
            </radialGradient>

            {/* the caustic where both arcs meet the right edge */}
            <radialGradient id="orq-flare" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
              <stop offset="30%" stopColor="#f0edff" stopOpacity="0.42" />
              <stop offset="65%" stopColor="#b9aaff" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#a99cff" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/*
           * The light's body: the interior glow and the caustic where the arcs
           * meet the right edge. `landing-sweep-focus` is the group the pointer
           * moves — the whole body travels, so the caustic leads and the glow
           * follows it (see `interactive-sweep.tsx` and the stylesheet).
           */}
          <g className="landing-sweep-focus">
            {/* diffuse light between the arcs, strongest near the focus */}
            <ellipse
              cx={1240}
              cy={SWEEP_FOCUS.y}
              rx={430}
              ry={270}
              fill="url(#orq-glow)"
              filter="url(#orq-blur-80)"
            />

            {/* the bright convergence at the right edge */}
            <ellipse
              cx={1428}
              cy={SWEEP_FOCUS.y}
              rx={196}
              ry={74}
              fill="url(#orq-flare)"
              filter="url(#orq-blur-30)"
            />
            <ellipse
              cx={1440}
              cy={SWEEP_FOCUS.y}
              rx={112}
              ry={40}
              fill="url(#orq-flare)"
              filter="url(#orq-blur-7)"
            />
          </g>

          {/*
           * The beams. They travel with the light's body, but only a third as
           * far — parallax, so the sweep leans toward the pointer rather than
           * sliding away from its own arcs.
           */}
          <g className="landing-sweep-arcs">
            {SWEEP_PATHS.map((path) => (
              <g key={path.d}>
                {path.weight === "outer" ? (
                  <path
                    d={path.d}
                    fill="none"
                    stroke="url(#orq-fade-white)"
                    strokeWidth={150}
                    strokeLinecap="round"
                    opacity={0.07}
                    filter="url(#orq-blur-80)"
                  />
                ) : null}

                {/* band */}
                <path
                  d={path.d}
                  fill="none"
                  stroke="url(#orq-fade-color)"
                  strokeWidth={path.weight === "outer" ? 56 : 40}
                  strokeLinecap="round"
                  opacity={path.weight === "outer" ? 0.5 : 0.36}
                  filter="url(#orq-blur-30)"
                />

                {/*
                 * Chromatic fringing. The upper arc is fringed amber/magenta and
                 * the lower one cyan/violet, which is what gives the sweep its
                 * spectrum instead of a single violet wash.
                 */}
                <path
                  d={path.d}
                  fill="none"
                  stroke={path.fringe === "warm" ? "url(#orq-fade-amber)" : "url(#orq-fade-cyan)"}
                  strokeWidth={path.weight === "outer" ? 44 : 32}
                  strokeLinecap="round"
                  opacity={path.weight === "outer" ? 0.52 : 0.34}
                  filter="url(#orq-blur-30)"
                  transform="translate(-11, -9)"
                />
                <path
                  d={path.d}
                  fill="none"
                  stroke={
                    path.fringe === "warm" ? "url(#orq-fade-magenta)" : "url(#orq-fade-violet)"
                  }
                  strokeWidth={path.weight === "outer" ? 44 : 32}
                  strokeLinecap="round"
                  opacity={path.weight === "outer" ? 0.48 : 0.32}
                  filter="url(#orq-blur-30)"
                  transform="translate(11, 9)"
                />

                {/* caustic core — a soft glow plus the crisp line that reads as light */}
                <path
                  d={path.d}
                  fill="none"
                  stroke="url(#orq-fade-white)"
                  strokeWidth={path.weight === "outer" ? 11 : 7}
                  strokeLinecap="round"
                  opacity={path.weight === "outer" ? 1 : 0.8}
                  filter="url(#orq-blur-7)"
                />
                {path.weight === "outer" ? (
                  <path
                    d={path.d}
                    fill="none"
                    stroke="url(#orq-fade-white)"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    opacity={0.55}
                  />
                ) : null}
              </g>
            ))}
          </g>
        </svg>
      </div>

      {/*
       * The light travelling along those beams: the same paths, drawn from
       * gradients that move (see `FLOW_SECONDS` above). The layer's own opacity
       * is the gate — it rests at zero and is lifted once by SMIL, so a renderer
       * without SMIL shows the hero exactly as drawn rather than a stopped wave.
       */}
      <div className="landing-sweep-breath absolute inset-0 origin-right">
        <svg
          viewBox="0 0 1440 900"
          preserveAspectRatio="xMidYMid slice"
          className="landing-sweep landing-sweep-flow h-full w-full"
          opacity={0}
        >
          <animate attributeName="opacity" to="1" dur="1.5s" fill="freeze" />

          <defs>
            {FLOW_GRADIENTS.map((gradient) => (
              <linearGradient
                key={gradient.id}
                id={gradient.id}
                gradientUnits="userSpaceOnUse"
                spreadMethod="repeat"
                x1={SWEEP_FOCUS.x}
                y1={SWEEP_FOCUS.y}
                x2={780}
                y2={SWEEP_FOCUS.y}
              >
                {gradient.stops.map(([offset, color, opacity]) => (
                  <stop
                    key={`${gradient.id}-${offset}`}
                    offset={`${Number(offset) * 100}%`}
                    stopColor={color}
                    stopOpacity={Number(opacity)}
                  />
                ))}
                {/*
                 * The offset itself: one period toward the focus, repeating. It
                 * is a translate of the gradient, never of the artwork.
                 */}
                <animateTransform
                  attributeName="gradientTransform"
                  type="translate"
                  from="0 0"
                  to={`${FLOW_PERIOD} 0`}
                  dur={`${FLOW_SECONDS}s`}
                  repeatCount="indefinite"
                />
              </linearGradient>
            ))}
          </defs>

          {/* The pointer's offset is mirrored onto this group, so the light stays
              on its own beams when the visitor drives the hero. */}
          <g className="landing-sweep-flow-arcs">
            {SWEEP_PATHS.map((path) => (
              <g key={`flow-${path.d}`}>
                {/* the swell inside the beam */}
                <path
                  d={path.d}
                  fill="none"
                  stroke="url(#orq-flow-body)"
                  strokeWidth={path.weight === "outer" ? 56 : 40}
                  strokeLinecap="round"
                  opacity={path.weight === "outer" ? 0.3 : 0.22}
                  filter="url(#orq-blur-30)"
                />
                {/* and the thread that runs along its centre */}
                <path
                  d={path.d}
                  fill="none"
                  stroke="url(#orq-flow-line)"
                  strokeWidth={path.weight === "outer" ? 2.4 : 1.6}
                  strokeLinecap="round"
                  opacity={path.weight === "outer" ? 0.4 : 0.3}
                />
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}

/** Container: one measure for the whole page (matches the app's widest layout). */
export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[1720px] px-6 md:px-10 xl:px-16", className)}>
      {children}
    </div>
  );
}

/**
 * Section rhythm. `tone="light"` inverts the section (white surface, dark text)
 * — used once, for the quickstart, so the page breathes.
 */
export function Section({
  id,
  eyebrow,
  title,
  lede,
  aside,
  children,
  tone = "dark",
  className,
}: {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  tone?: "dark" | "light";
  className?: string;
}) {
  const light = tone === "light";
  return (
    <section
      id={id}
      className={cn(
        "scroll-mt-20 py-20 md:py-28",
        light ? "bg-[#f6f6f4] text-[#0a0a0b]" : "bg-[var(--home-bg)] text-[var(--home-text)]",
        className,
      )}
    >
      <Container>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
          <div className="min-w-0 flex-1">
            <p className={cn("landing-eyebrow", light && "text-[#6d6d76]")}>{eyebrow}</p>
            <h2
              className={cn(
                "landing-display mt-4 max-w-[860px] text-[clamp(26px,3.4vw,44px)]",
                light ? "text-[#0a0a0b]" : "text-[var(--home-text)]",
              )}
            >
              {title}
            </h2>
            {lede !== undefined ? (
              <p
                className={cn(
                  "mt-5 max-w-[640px] text-[15px] leading-relaxed",
                  light ? "text-[#4a4a52]" : "text-[var(--home-text-secondary)]",
                )}
              >
                {lede}
              </p>
            ) : null}
          </div>
          {aside !== undefined ? <div className="shrink-0">{aside}</div> : null}
        </div>
        {children !== undefined ? <div className="mt-12">{children}</div> : null}
      </Container>
    </section>
  );
}

/** Bordered panel — the page's basic surface. */
export function Frame({
  children,
  className,
  tone = "dark",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  tone?: "dark" | "elevated" | "light";
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        "border",
        tone === "dark" && "border-[var(--home-border)] bg-[var(--home-bg-card)]",
        tone === "elevated" && "border-[var(--home-border-strong)] bg-[var(--home-bg-elevated)]",
        tone === "light" && "border-black/10 bg-white",
        padded && "p-5 md:p-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Mono label chip, used inside cards and on the roadmap table. */
export function Chip({
  children,
  className,
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  tone?: "default" | "accent" | "muted";
}) {
  return (
    <span
      className={cn(
        "landing-mono inline-flex items-center gap-1.5 border px-2 py-0.5 text-[10.5px] tracking-[0.08em] uppercase",
        tone === "default" && "border-[var(--home-border)] text-[var(--home-text-faint)]",
        tone === "accent" &&
          "border-[color-mix(in_oklab,var(--home-violet)_45%,transparent)] text-[var(--home-violet)]",
        tone === "muted" && "border-transparent bg-white/[0.04] text-[var(--home-text-dim)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Terminal block with a mono title bar and a blinking cursor on the last line. */
export function Terminal({
  title,
  lines,
  className,
}: {
  title: string;
  lines: { prompt?: string; text: string }[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border border-[var(--home-border)] bg-[var(--home-bg-card)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--home-border)] px-3 py-2">
        <span aria-hidden="true" className="flex gap-1">
          <span className="h-1.5 w-1.5 bg-[var(--home-text-dim)]" />
          <span className="h-1.5 w-1.5 bg-[var(--home-text-dim)]" />
          <span className="h-1.5 w-1.5 bg-[var(--home-text-dim)]" />
        </span>
        <span className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-faint)] uppercase">
          {title}
        </span>
      </div>
      <pre className="landing-mono w-full overflow-x-auto px-4 py-3 text-[12.5px] leading-relaxed text-[var(--home-text-secondary)]">
        {lines.map((line, index) => (
          <span key={`${index}-${line.text}`} className="block">
            {line.prompt !== undefined ? (
              <span className="text-[var(--home-text-dim)]">{line.prompt} </span>
            ) : (
              <span className="text-[var(--home-text-dim)]">{`${"  "}`}</span>
            )}
            <span className="text-[var(--home-text)]">{line.text}</span>
            {index === lines.length - 1 ? (
              <span aria-hidden="true" className="landing-blink ml-1 inline-block">
                ▍
              </span>
            ) : null}
          </span>
        ))}
      </pre>
    </div>
  );
}

/** Infinite marquee: the items are rendered twice and translated by one half. */
export function Marquee({ items, className }: { items: string[]; className?: string }) {
  const half = (key: string) => (
    <ul key={key} className="flex items-center gap-8 pr-8" aria-hidden={key === "b"}>
      {items.map((item) => (
        <li
          key={`${key}-${item}`}
          className="landing-mono flex items-center gap-3 text-[12px] tracking-[0.12em] whitespace-nowrap text-[var(--home-text-faint)] uppercase"
        >
          <span aria-hidden="true" className="h-1 w-1 bg-[var(--home-text-dim)]" />
          {item}
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className={cn(
        "landing-marquee overflow-hidden border-y border-[var(--home-border)] py-4",
        className,
      )}
    >
      <div className="landing-marquee-track">
        {half("a")}
        {half("b")}
      </div>
    </div>
  );
}

/** Quiet text link with an arrow that slides on hover. */
export function ArrowLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-1.5 text-[13.5px] text-[var(--home-text-secondary)] transition-colors hover:text-[var(--home-text)]",
        className,
      )}
    >
      {children}
      <span
        aria-hidden="true"
        className="transition-transform duration-300 group-hover:translate-x-1"
      >
        →
      </span>
    </Link>
  );
}
