import Link from "next/link";
import type { ReactNode } from "react";
import { OrbitFavicon } from "@/components/brand/orbit-favicon";
import { OrqestraMark } from "@/components/brand/orqestra-mark";
import { CopyField } from "./copy-field";
import { InteractiveSweep } from "./interactive-sweep";
import { HARNESS_SAMPLE_JSON } from "./harness-sample";
import {
  ArrowLink,
  Aurora,
  Chip,
  Container,
  Frame,
  Marquee,
  Section,
  Terminal,
} from "./primitives";
import { Reveal } from "./reveal";
import { Starfield } from "./starfield";

/**
 * Orqestra's landing page.
 *
 * Design language follows the reference the product is styled after: a black
 * surface with an animated star field and an iridescent sweep, uppercase
 * display type, mono eyebrows and labels, hairline borders, square buttons and
 * one inverted (white) section for rhythm.
 *
 * The content is Orqestra's own vision — harness engineering — and every claim,
 * number and command on the page comes from the code in this repository:
 * the runtime pipeline, the twelve runtime primitives, the real verification
 * run quoted in the observability section, and the phases that are actually
 * shipped.
 */

const NAV_LINKS = [
  { href: "#thesis", label: "Thesis" },
  { href: "#pipeline", label: "Pipeline" },
  { href: "#runtime", label: "Runtime" },
  { href: "#runs", label: "Runs" },
  { href: "#roadmap", label: "Roadmap" },
];

/*
 * The footer is a directory, the way the reference's is: a wide grid of narrow
 * columns, small type, one honest footnote and a bar of quiet controls. Every
 * destination in it exists in this repository — a page, a section of this page,
 * or a JSON endpoint you can actually call — because a footer is a promise about
 * where things are, and a dead link in it is the cheapest way to look unfinished.
 *
 * The desktop grid is the reference's own: brand over two slots, then one
 * column per group, eight in all — which is where seven groups come from rather
 * than the three a footer usually gets away with. A group's links may repeat an
 * anchor (five policies are five things the runtime enforces in one section of
 * this page); no group repeats another's labels, and nothing links anywhere the
 * repository does not serve.
 */
const FOOTER_COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Runs", href: "/dashboard/runs" },
      { label: "Sign in", href: "/login" },
      { label: "Start building", href: "/login" },
    ],
  },
  {
    title: "Runtime",
    links: [
      { label: "Compiler", href: "#pipeline" },
      { label: "Primitives", href: "#runtime" },
      { label: "Execution plan", href: "#pipeline" },
      { label: "Models & tools", href: "#models" },
      { label: "Roadmap", href: "#roadmap" },
    ],
  },
  {
    title: "Guards",
    links: [
      { label: "Tool permissions", href: "#runtime" },
      { label: "Loop guards", href: "#runtime" },
      { label: "Execution limits", href: "#runtime" },
      { label: "Retry policy", href: "#runtime" },
      { label: "Termination", href: "#runtime" },
    ],
  },
  {
    title: "Observe",
    links: [
      { label: "Trace", href: "#runs" },
      { label: "Runtime events", href: "#runs" },
      { label: "Usage & cost", href: "#runs" },
      { label: "SSE updates", href: "#runs" },
      { label: "Queue worker", href: "#runtime" },
    ],
  },
  {
    title: "Build",
    links: [
      { label: "Harness DSL", href: "#quickstart" },
      { label: "Graph validation", href: "#quickstart" },
      { label: "Versioning", href: "#runtime" },
      { label: "Node executors", href: "#runtime" },
    ],
  },
  {
    title: "API",
    links: [
      { label: "Health", href: "/api/health" },
      { label: "Tools", href: "/api/tools" },
      { label: "Projects", href: "/api/projects" },
      { label: "Runs", href: "/api/runs" },
      { label: "Agents", href: "/api/agents" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Thesis", href: "#thesis" },
      { label: "Quickstart", href: "#quickstart" },
      { label: "Phases", href: "#roadmap" },
      { label: "System health", href: "/api/health" },
    ],
  },
] as const;

const MARQUEE_ITEMS = [
  "Harness DSL v2",
  "Graph validation",
  "Compiler",
  "Execution plan",
  "State machine",
  "Node executors",
  "Expression resolver",
  "Tool registry",
  "Tool permissions",
  "Loop guards",
  "Execution limits",
  "Retry policy",
  "Runtime events",
  "Trace",
  "Usage & cost",
  "Queue worker",
  "SSE updates",
];

/** The compiler pipeline, in order. Also the animated "executing" diagram. */
const PIPELINE_STEPS = [
  {
    index: "01",
    title: "Harness definition",
    detail: "A directed graph of behaviour: nodes, edges, entry, exits.",
  },
  {
    index: "02",
    title: "Validator",
    detail: "Schema, duplicate ids, reachability, termination — graph integrity first.",
  },
  {
    index: "03",
    title: "Compiler",
    detail: "Normalized nodes, resolved edges, an executable plan or precise issues.",
  },
  {
    index: "04",
    title: "Runtime",
    detail: "A typed state machine. Explicit transitions: queued → running → done.",
  },
  {
    index: "05",
    title: "Node executors",
    detail: "Model · prompt · context · tool · planner · critic · condition · loop.",
  },
  {
    index: "06",
    title: "Policies",
    detail: "Limits, retry classification and tool permissions — checked every step.",
  },
  {
    index: "07",
    title: "Runtime events",
    detail: "RUN_STARTED, NODE_COMPLETED, TOOL_CALLED, RUN_FAILED … in order.",
  },
  {
    index: "08",
    title: "Trace → Run",
    detail: "Steps, events, usage and status persisted; the run never mutates again.",
  },
];

/** The runtime's primitives — what a harness author actually gets to design with. */
const PRIMITIVES = [
  {
    number: "01",
    title: "Model node",
    body: '"provider:model" as data behind one gateway. Gemini, Ollama or a deterministic mock — no provider SDK leaks into the runtime.',
    tags: ["node", "gateway"],
  },
  {
    number: "02",
    title: "Prompt & context",
    body: "Templates and context construction with {{ }} references resolved by a parser. Expressions are never eval'd.",
    tags: ["node", "resolver"],
  },
  {
    number: "03",
    title: "Tool registry",
    body: "Validated input, one execute, typed result. Calculator, JSON transform, HTTP fetch and current time ship in the box.",
    tags: ["tool", "zod"],
  },
  {
    number: "04",
    title: "Tool permissions",
    body: "Every call passes a permission layer first: a tool outside the allowlist fails the step instead of running.",
    tags: ["policy"],
  },
  {
    number: "05",
    title: "Condition & router",
    body: "Deterministic branch selection with declared handles, so every path through a graph is provable before it runs.",
    tags: ["node", "edges"],
  },
  {
    number: "06",
    title: "Loops",
    body: "Return to an earlier node only through explicit loop semantics, with the iteration count tracked and a hard ceiling enforced.",
    tags: ["node", "limits"],
  },
  {
    number: "07",
    title: "Planner",
    body: "An LLM produces a structured plan. The runtime consumes JSON — never parsed prose.",
    tags: ["node", "structured"],
  },
  {
    number: "08",
    title: "Critic",
    body: "Scores a draft against instructions and returns a structured critique a condition can branch on.",
    tags: ["node", "structured"],
  },
  {
    number: "09",
    title: "Execution limits",
    body: "Duration, nodes, iterations, tool calls, LLM calls and cost are budgeted per run; a limit ends the run safely and says why.",
    tags: ["policy", "budget"],
  },
  {
    number: "10",
    title: "Retry policy",
    body: "Transient failures retry with backoff. Validation, permission and permanent errors never do.",
    tags: ["policy"],
  },
  {
    number: "11",
    title: "Trace & events",
    body: "Each node writes a step with its own trace document; the run keeps the full event stream for replay and debugging.",
    tags: ["trace", "api"],
  },
  {
    number: "12",
    title: "Queue & worker",
    body: "A request creates the run row and enqueues; the worker compiles and executes it. Duplicate delivery cannot run it twice.",
    tags: ["queue", "worker"],
  },
];

/** The observability section quotes one real run from the repository. */
const EXAMPLE_RUN = {
  id: "#tc93a2",
  status: "Completed",
  harness: "Research harness v1",
  model: "mock:deterministic",
  duration: "5.4s",
  tokens: "444",
  calls: "2",
  cost: "$0.00000",
  engine: "orqestra-runtime/0.2.0",
  hash: "96d9bb921cd0…",
  transport: "queue",
  nodes: "8",
  edges: "9",
  steps: [
    { label: "Start", type: "start", duration: "283ms", iteration: null as number | null },
    { label: "Refine loop", type: "loop", duration: "286ms", iteration: 1 },
    { label: "Planner", type: "planner", duration: "274ms", iteration: null },
    { label: "Clock", type: "tool", duration: "283ms", iteration: null },
    { label: "Critic", type: "critic", duration: "332ms", iteration: null },
    { label: "Score gate", type: "condition", duration: "333ms", iteration: null },
    { label: "Compose answer", type: "transform", duration: "435ms", iteration: null },
    { label: "End", type: "end", duration: "316ms", iteration: null },
  ],
};

const MODEL_ROWS = [
  {
    name: "Gemini",
    detail: "Text and structured output, streaming where practical, token usage reported per call.",
  },
  {
    name: "Ollama",
    detail: "Local models through the same interface. Nothing about a harness changes.",
  },
  { name: "Mock", detail: "Deterministic responses for tests and demos — no credits, no network." },
  {
    name: "Gateway",
    detail:
      'Resolves "provider:model" once, marks unconfigured providers without throwing, keys stay server-side.',
  },
];

const INFRA_ROWS = [
  {
    name: "PostgreSQL + Prisma 7",
    detail: "Agents, harnesses, versions, runs, steps, traces, usage.",
  },
  {
    name: "Redis + BullMQ",
    detail: "The run queue. Optional in development: inline mode needs no Redis.",
  },
  {
    name: "Server-Sent Events",
    detail: "Live run updates over one connection — no WebSockets to operate.",
  },
  {
    name: "Vitest + Playwright",
    detail: "156 runtime and unit tests, 12 end-to-end flows against a production build.",
  },
];

const ROADMAP = [
  {
    phase: "Phase 0",
    title: "Foundation & architecture",
    detail: "Domain model, database, auth, provider abstractions, environment.",
    status: "Delivered",
  },
  {
    phase: "Phase 1",
    title: "Visual harness builder",
    detail: "React Flow editor, node inspector, validation, immutable versions, import/export.",
    status: "Delivered",
  },
  {
    phase: "Phase 2",
    title: "Agent runtime",
    detail: "Compiler → execution plan → state machine → node executors → events → trace → run.",
    status: "Delivered",
  },
  {
    phase: "Phase 3",
    title: "Evaluation framework",
    detail: "Datasets, evaluators and scores that turn finished runs into evidence.",
    status: "Next",
  },
  {
    phase: "Phase 4",
    title: "Loop engineering & experiments",
    detail: "Compare pinned harness versions against each other, and let the harness improve.",
    status: "Planned",
  },
];

export function LandingPage() {
  return (
    <div id="top" className="landing relative min-h-dvh">
      {/* The tab icon runs while the page is open — see `brand/orbit-favicon`. */}
      <OrbitFavicon />

      {/* Fixed navigation --------------------------------------------------- */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-[var(--home-border)] bg-[color-mix(in_oklab,var(--home-bg)_82%,transparent)] backdrop-blur-md">
        <Container className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5 no-underline">
              <OrqestraMark animated className="h-7 w-7 text-[var(--home-text)]" />
              <span className="text-[22px] leading-none font-bold tracking-tight">orqestra</span>
            </Link>
            <nav aria-label="Sections" className="hidden items-center gap-6 md:flex">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-[13.5px] text-[var(--home-text-secondary)] transition-colors hover:text-[var(--home-text)]"
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="hidden border border-[var(--home-border-strong)] px-4 py-1.5 text-[13.5px] text-[var(--home-text)] transition-colors hover:bg-white/[0.06] sm:block"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="bg-white px-4 py-2 text-[13.5px] font-medium text-black transition-opacity hover:opacity-85"
            >
              Start building
            </Link>
          </div>
        </Container>
      </header>

      {/* Hero --------------------------------------------------------------- */}
      {/*
       * The hero and the marquee band are one screen between them: the section's
       * minimum is the viewport minus the header and minus the band, which is why
       * it carries no bottom border of its own — the band's own `border-y` is the
       * line between them, and drawing it twice also pushed the band 1px past the
       * fold. `--hero-step` is the rhythm everything inside is spaced by (see
       * `globals.css`), so short viewports compress instead of overflowing.
       */}
      <section className="relative isolate overflow-hidden pt-16">
        <Starfield
          className="absolute inset-0 h-full w-full opacity-95"
          density={0.00045}
          maxRadius={1.15}
        />
        <InteractiveSweep />
        <div aria-hidden="true" className="landing-noise pointer-events-none absolute inset-0" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[var(--home-bg)] to-transparent"
        />

        <Container className="relative z-10 flex min-h-[calc(100dvh_-_64px_-_var(--landing-marquee-height))] flex-col justify-between pt-16 pb-[calc(var(--hero-step)*4)] md:pt-[calc(var(--hero-step)*12)]">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,var(--hero-artwork))] lg:items-start">
            <Reveal className="flex flex-col items-start">
              <p className="landing-eyebrow"># Harness engineering platform</p>
              <h1 className="landing-display mt-[calc(var(--hero-step)*3)] max-w-[15ch] text-[length:var(--hero-display)]">
                <span className="landing-gradient-text">Harness</span> engineering
                <br />
                infrastructure.
              </h1>
              <p className="mt-[calc(var(--hero-step)*3.5)] max-w-[560px] text-[15.5px] leading-relaxed text-[var(--home-text-secondary)]">
                The model provides intelligence. The harness controls behavior. Orqestra turns an
                agent&apos;s behaviour into a versioned graph you compile, execute, trace and
                compare — one node at a time.
              </p>

              <CopyField
                className="mt-[calc(var(--hero-step)*4.5)] max-w-[560px]"
                label="Define the behaviour. Let the runtime execute it."
                hint="Click to copy the research harness definition"
                value={HARNESS_SAMPLE_JSON}
              />

              <div className="mt-[calc(var(--hero-step)*4.5)] flex flex-wrap items-center gap-x-8 gap-y-4">
                <Link
                  href="/login"
                  className="bg-white px-6 py-3 text-[14px] font-medium text-black transition-opacity hover:opacity-85"
                >
                  Start building
                </Link>
                <ArrowLink href="#pipeline">See the pipeline</ArrowLink>
                <ArrowLink href="/dashboard">Open the dashboard</ArrowLink>
              </div>
            </Reveal>

            {/* The right half is deliberately empty: the aurora is the artwork. */}
            <div aria-hidden="true" className="hidden h-[var(--hero-artwork)] lg:block" />
          </div>
        </Container>
      </section>

      <Marquee items={MARQUEE_ITEMS} className="bg-[var(--home-bg)]" />

      {/* Thesis ------------------------------------------------------------- */}
      <Section
        id="thesis"
        eyebrow="# The thesis"
        title={<>Agents don&apos;t fail because the model is weak.</>}
        lede="They fail because behaviour was never an artifact you could version, review or reproduce. Orqestra separates who the agent is from how it behaves — and makes the second one executable."
      >
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:gap-16">
          <Reveal className="flex flex-col gap-6">
            <p className="text-[15px] leading-relaxed text-[var(--home-text-secondary)]">
              A prompt is not a system. Sequencing, tool routing, retries, budgets, termination —
              that is where agents actually live or die, and none of it fits in a paragraph of
              instructions.
            </p>
            <p className="text-[15px] leading-relaxed text-[var(--home-text-secondary)]">
              A harness is a directed graph of behaviour: plan, call tools, criticise, branch, loop,
              stop. It is validated before it runs, compiled into an execution plan, and immutable
              once published — content-hashed, so two authors describing the same behaviour get the
              same identity.
            </p>
            <p className="text-[15px] leading-relaxed text-[var(--home-text-secondary)]">
              Every run pins the exact version that produced it. Retrying never mutates history; it
              creates a new run that points back at its predecessor, which is what makes a
              regression attributable instead of anecdotal.
            </p>
          </Reveal>

          <Reveal delay={100}>
            <Frame className="flex flex-col divide-y divide-[var(--home-border)] p-0">
              {[
                {
                  label: "Agent",
                  value: "Who it is",
                  detail: "Identity, purpose, instructions, model, capabilities.",
                },
                {
                  label: "Harness",
                  value: "How it behaves",
                  detail: "Flow, tools, context, loops, failure handling, termination.",
                },
                {
                  label: "Run",
                  value: "One pinned execution",
                  detail: "Version, model, limits, input — recorded, never rewritten.",
                },
                {
                  label: "Trace",
                  value: "The ordered truth",
                  detail: "Steps, events, tokens, cost and errors, in sequence.",
                },
              ].map((row) => (
                <div key={row.label} className="flex flex-col gap-1 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <span className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
                      {row.label}
                    </span>
                    <span className="text-[13.5px] font-medium text-[var(--home-text)]">
                      {row.value}
                    </span>
                  </div>
                  <p className="text-[12.5px] leading-relaxed text-[var(--home-text-faint)]">
                    {row.detail}
                  </p>
                </div>
              ))}
            </Frame>
          </Reveal>
        </div>
      </Section>

      {/* Pipeline ----------------------------------------------------------- */}
      <Section
        id="pipeline"
        eyebrow="# The pipeline"
        title="Harness in. Trace out."
        lede="Validation, compilation, execution and tracing are separate stages. The runtime is a domain engine — not a request handler — so the same code path serves the API, the queue worker and the tests."
        aside={
          <div className="landing-mono flex flex-wrap gap-x-6 gap-y-2 text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
            <span>no React in the engine</span>
            <span>no eval</span>
            <span>no provider SDK in the domain</span>
          </div>
        }
      >
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:gap-16">
          <Reveal className="relative">
            <ol className="flex flex-col gap-3">
              {PIPELINE_STEPS.map((step, index) => (
                <li
                  key={step.index}
                  className="landing-step flex items-start gap-4 border border-[var(--home-border)] bg-[var(--home-bg-card)] px-4 py-3"
                  style={{ animationDelay: `${index * 0.95}s` }}
                >
                  <span className="landing-mono pt-0.5 text-[11px] text-[var(--home-text-dim)]">
                    {step.index}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-[var(--home-text)]">
                      {step.title}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] leading-relaxed text-[var(--home-text-faint)]">
                      {step.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Reveal>

          <Reveal delay={120} className="flex flex-col gap-6">
            <Frame className="p-0">
              <div className="flex items-center justify-between border-b border-[var(--home-border)] px-4 py-3">
                <span className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-faint)] uppercase">
                  Example run · mock provider
                </span>
                <span className="landing-mono flex items-center gap-2 text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
                  <span
                    aria-hidden="true"
                    className="landing-pulse h-1.5 w-1.5 bg-[var(--home-green)]"
                  />
                  completed
                </span>
              </div>
              <ul className="divide-y divide-[var(--home-border)]">
                {EXAMPLE_RUN.steps.map((step, index) => (
                  <li
                    key={`${step.label}-${index}`}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <span className="landing-mono w-[86px] shrink-0 truncate text-[11px] text-[var(--home-text-dim)]">
                      {step.type}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--home-text)]">
                      {step.label}
                      {step.iteration !== null ? (
                        <span className="landing-mono ml-2 text-[10.5px] text-[var(--home-text-dim)]">
                          iteration {step.iteration}
                        </span>
                      ) : null}
                    </span>
                    <span aria-hidden="true" className="h-1 w-16 bg-white/5">
                      <span
                        className="landing-bar block h-1 bg-[var(--home-text-dim)]"
                        style={{ animationDelay: `${index * 0.95}s` }}
                      />
                    </span>
                    <span className="landing-mono w-[52px] shrink-0 text-right text-[11px] text-[var(--home-text-faint)]">
                      {step.duration}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-[var(--home-border)] px-4 py-3">
                <span className="landing-mono text-[10.5px] tracking-[0.1em] text-[var(--home-text-dim)] uppercase">
                  8 steps · 444 tokens · 2 model calls · cost $0.00000
                </span>
              </div>
            </Frame>
            <p className="landing-mono text-[10.5px] leading-relaxed tracking-[0.08em] text-[var(--home-text-dim)] uppercase">
              Numbers above come from this repository&apos;s own verification run — not from an
              illustration.
            </p>
          </Reveal>
        </div>
      </Section>

      {/* Runtime primitives -------------------------------------------------- */}
      <Section
        id="runtime"
        eyebrow="# Inside the runtime"
        title="Twelve primitives, one contract."
        lede="Everything a harness can do is a node type or a policy — declared in the DSL, validated before execution, and traced when it runs."
        aside={
          <div className="landing-mono flex flex-wrap gap-2">
            <Chip tone="accent">compiler</Chip>
            <Chip>state machine</Chip>
            <Chip>policies</Chip>
            <Chip>events</Chip>
          </div>
        }
      >
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {PRIMITIVES.map((item, index) => (
            <Reveal as="li" key={item.number} delay={(index % 3) * 90}>
              <Frame className="group h-full transition-colors hover:border-[var(--home-border-strong)]">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="landing-mono text-[11px] text-[var(--home-text-dim)]">
                    {item.number}
                  </span>
                  <span className="flex gap-1.5">
                    {item.tags.map((tag) => (
                      <Chip key={tag} tone="muted">
                        {tag}
                      </Chip>
                    ))}
                  </span>
                </div>
                <h3 className="mt-4 text-[15px] font-medium text-[var(--home-text)]">
                  {item.title}
                </h3>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--home-text-secondary)]">
                  {item.body}
                </p>
              </Frame>
            </Reveal>
          ))}
        </ul>
      </Section>

      {/* Quickstart (inverted) ---------------------------------------------- */}
      <Section
        tone="light"
        id="quickstart"
        eyebrow="# Quickstart"
        title="From a saved version to a traced run."
        lede="Four steps, and no framework in the way: the repository ships the whole loop, including the worker that executes it."
        aside={
          <div className="landing-mono flex flex-wrap gap-2 text-[10.5px] tracking-[0.12em] uppercase">
            <span className="border border-black/15 px-2 py-0.5">pnpm dev</span>
            <span className="border border-black/15 px-2 py-0.5">pnpm worker</span>
            <span className="border border-black/15 px-2 py-0.5">pnpm verify</span>
          </div>
        }
      >
        <div className="grid gap-6 lg:grid-cols-3">
          {[
            {
              step: "01",
              title: "Design the graph",
              body: "Drag nodes in the builder, connect them, configure each one. Validation runs as you edit — reachability, termination, branch completeness.",
            },
            {
              step: "02",
              title: "Publish a version",
              body: "Publishing is write-once and content-hashed. Identical definitions are the same version; the run is pinned to what you published.",
            },
            {
              step: "03",
              title: "Run and watch",
              body: "Press Run: the API creates the run row and enqueues it. The worker compiles, executes and streams events back while the timeline fills in.",
            },
          ].map((card, index) => (
            <Reveal key={card.step} delay={index * 90}>
              <div className="h-full border border-black/10 bg-white p-6">
                <span className="landing-mono text-[11px] text-[#6d6d76]">{card.step}</span>
                <h3 className="mt-4 text-[16px] font-semibold text-[#0a0a0b]">{card.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-[#4a4a52]">{card.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
          <Reveal>
            <Terminal
              title="terminal · local development"
              lines={[
                {
                  prompt: "$",
                  text: "pnpm dev            # dashboard → project → agent → harness → builder",
                },
                {
                  prompt: "$",
                  text: "pnpm worker         # BullMQ worker for the orqestra.runs queue",
                },
                {
                  prompt: "$",
                  text: "pnpm verify         # lint · typecheck · 156 tests · production build",
                },
                { prompt: "$", text: "RUN_EXECUTION_MODE=inline pnpm dev   # no Redis required" },
              ]}
            />
          </Reveal>
          <Reveal delay={120}>
            <div className="flex h-full flex-col justify-between border border-black/10 bg-white p-6">
              <p className="text-[13.5px] leading-relaxed text-[#4a4a52]">
                The same runtime executes in both modes. The queue only decides where the work
                happens, and every run records which transport executed it.
              </p>
              <dl className="mt-6 grid grid-cols-2 gap-4">
                {[
                  { term: "Tests", value: "156" },
                  { term: "E2E flows", value: "12" },
                  { term: "Providers", value: "3" },
                  { term: "Tools", value: "4" },
                ].map((stat) => (
                  <div key={stat.term}>
                    <dt className="landing-mono text-[10.5px] tracking-[0.12em] text-[#6d6d76] uppercase">
                      {stat.term}
                    </dt>
                    <dd className="mt-1 text-[20px] font-semibold text-[#0a0a0b]">{stat.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* Observability ------------------------------------------------------ */}
      <Section
        id="runs"
        eyebrow="# Observability"
        title="Every run explains itself."
        lede="Status, timeline, per-step input and output, token usage, cost — and the pins that make the run reproducible years later."
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <Reveal>
            <Frame className="p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--home-border)] px-5 py-4">
                <div>
                  <p className="text-[15px] font-medium text-[var(--home-text)]">Research Agent</p>
                  <p className="landing-mono mt-1 text-[10.5px] tracking-[0.1em] text-[var(--home-text-dim)] uppercase">
                    {EXAMPLE_RUN.harness} · run {EXAMPLE_RUN.id} · {EXAMPLE_RUN.model}
                  </p>
                </div>
                <span className="landing-mono flex items-center gap-2 border border-[color-mix(in_oklab,var(--home-green)_45%,transparent)] px-2.5 py-1 text-[10.5px] tracking-[0.12em] text-[var(--home-green)] uppercase">
                  <span aria-hidden="true" className="h-1.5 w-1.5 bg-[var(--home-green)]" />
                  {EXAMPLE_RUN.status}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-px border-b border-[var(--home-border)] bg-[var(--home-border)] sm:grid-cols-4">
                {[
                  { term: "Duration", value: EXAMPLE_RUN.duration },
                  { term: "Steps", value: EXAMPLE_RUN.nodes },
                  { term: "Tokens", value: EXAMPLE_RUN.tokens },
                  { term: "Cost", value: EXAMPLE_RUN.cost },
                ].map((stat) => (
                  <div key={stat.term} className="bg-[var(--home-bg-card)] px-5 py-4">
                    <dt className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
                      {stat.term}
                    </dt>
                    <dd className="landing-mono mt-1 text-[15px] text-[var(--home-text)]">
                      {stat.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <ol className="divide-y divide-[var(--home-border)]">
                {EXAMPLE_RUN.steps.map((step, index) => (
                  <li key={`${step.label}-detail`} className="flex items-center gap-4 px-5 py-3">
                    <span
                      aria-hidden="true"
                      className="landing-mono text-[11px] text-[var(--home-text-dim)]"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span
                      className="h-1.5 w-1.5 shrink-0 bg-[var(--home-green)]"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-[var(--home-text)]">
                        {step.label}
                      </span>
                      <span className="landing-mono block text-[10.5px] tracking-[0.1em] text-[var(--home-text-dim)] uppercase">
                        {step.type}
                        {step.iteration !== null ? ` · iteration ${step.iteration}` : ""}
                      </span>
                    </span>
                    <span className="landing-mono text-[11px] text-[var(--home-text-faint)]">
                      {step.duration}
                    </span>
                  </li>
                ))}
              </ol>
            </Frame>
          </Reveal>

          <Reveal delay={120} className="flex flex-col gap-6">
            <Frame>
              <p className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
                Usage
              </p>
              <div className="mt-4 flex flex-col gap-3">
                {[
                  { label: "Model calls", value: EXAMPLE_RUN.calls },
                  { label: "Total tokens", value: `${EXAMPLE_RUN.tokens} (341 in · 103 out)` },
                  { label: "Estimated cost", value: `${EXAMPLE_RUN.cost} · local provider` },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-baseline justify-between gap-4 border-b border-[var(--home-border)] pb-2 last:border-b-0 last:pb-0"
                  >
                    <span className="text-[12.5px] text-[var(--home-text-faint)]">{row.label}</span>
                    <span className="landing-mono text-[12px] text-[var(--home-text)]">
                      {row.value}
                    </span>
                  </div>
                ))}
              </div>
            </Frame>

            <Frame>
              <p className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
                Reproducibility
              </p>
              <dl className="mt-4 flex flex-col gap-2">
                {[
                  { term: "Engine", value: EXAMPLE_RUN.engine },
                  { term: "Content hash", value: EXAMPLE_RUN.hash },
                  {
                    term: "Graph",
                    value: `${EXAMPLE_RUN.nodes} nodes · ${EXAMPLE_RUN.edges} edges`,
                  },
                  { term: "Transport", value: EXAMPLE_RUN.transport },
                  { term: "Limits", value: "120s · 100 nodes · 10 iterations · 30 LLM calls" },
                ].map((row) => (
                  <div key={row.term} className="flex items-baseline justify-between gap-4">
                    <dt className="text-[12.5px] text-[var(--home-text-faint)]">{row.term}</dt>
                    <dd className="landing-mono text-[11.5px] text-[var(--home-text)]">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Frame>

            <Frame className="border-[color-mix(in_oklab,var(--home-amber)_35%,transparent)]">
              <p className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-amber)] uppercase">
                When a run fails
              </p>
              <p className="mt-3 text-[13px] leading-relaxed text-[var(--home-text-secondary)]">
                The step that broke, a plain reason, and whether a retry makes sense — no stack
                traces, no keys, no internal paths.
              </p>
              <div className="mt-4 border border-[var(--home-border)] bg-[var(--home-bg)] p-3">
                <p className="landing-mono text-[11px] text-[var(--home-text-faint)]">
                  node: clock
                </p>
                <p className="mt-1 text-[13px] text-[var(--home-text)]">Tool request timed out.</p>
                <p className="landing-mono mt-1 text-[10.5px] tracking-[0.1em] text-[var(--home-text-dim)] uppercase">
                  retryable · yes
                </p>
                <p className="mt-3 flex gap-4">
                  <span className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-secondary)] uppercase">
                    view node
                  </span>
                  <span className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-secondary)] uppercase">
                    retry run
                  </span>
                </p>
              </div>
              <p className="landing-mono mt-3 text-[10.5px] leading-relaxed tracking-[0.08em] text-[var(--home-text-dim)] uppercase">
                Retry creates a new run; the original is never rewritten.
              </p>
            </Frame>
          </Reveal>
        </div>
      </Section>

      {/* Models & infrastructure -------------------------------------------- */}
      <Section
        id="models"
        eyebrow="# Bring your own"
        title="Your model. Your tools. Your infrastructure."
        lede="A harness describes behaviour, not vendors. Swapping the model or adding a tool never changes the graph."
        aside={
          <div className="landing-mono flex flex-wrap gap-2">
            <Chip tone="accent">gemini</Chip>
            <Chip>ollama</Chip>
            <Chip>mock</Chip>
          </div>
        }
      >
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal className="flex flex-col gap-3">
            {MODEL_ROWS.map((row) => (
              <div
                key={row.name}
                className="flex flex-col gap-1 border border-[var(--home-border)] bg-[var(--home-bg-card)] px-5 py-4"
              >
                <span className="text-[14px] font-medium text-[var(--home-text)]">{row.name}</span>
                <span className="text-[12.5px] leading-relaxed text-[var(--home-text-faint)]">
                  {row.detail}
                </span>
              </div>
            ))}
          </Reveal>
          <Reveal delay={120} className="flex flex-col gap-3">
            {INFRA_ROWS.map((row) => (
              <div
                key={row.name}
                className="flex flex-col gap-1 border border-[var(--home-border)] bg-[var(--home-bg-card)] px-5 py-4"
              >
                <span className="text-[14px] font-medium text-[var(--home-text)]">{row.name}</span>
                <span className="text-[12.5px] leading-relaxed text-[var(--home-text-faint)]">
                  {row.detail}
                </span>
              </div>
            ))}
          </Reveal>
        </div>
      </Section>

      {/* Roadmap ------------------------------------------------------------ */}
      <Section
        id="roadmap"
        eyebrow="# Roadmap"
        title="Shipped, and what the runtime unlocks."
        lede="Harness engineering is a sequence: first behaviour you can execute, then behaviour you can measure, then behaviour that improves."
      >
        <Reveal>
          <Frame className="overflow-hidden p-0">
            <div className="hidden grid-cols-[110px_minmax(0,1fr)_minmax(0,1.4fr)_120px] border-b border-[var(--home-border)] px-5 py-3 md:grid">
              {["Phase", "Deliverable", "What it means", "Status"].map((head) => (
                <span
                  key={head}
                  className="landing-mono text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase"
                >
                  {head}
                </span>
              ))}
            </div>
            {ROADMAP.map((row) => (
              <div
                key={row.phase}
                className="grid gap-2 border-b border-[var(--home-border)] px-5 py-4 last:border-b-0 md:grid-cols-[110px_minmax(0,1fr)_minmax(0,1.4fr)_120px] md:items-baseline"
              >
                <span className="landing-mono text-[11px] text-[var(--home-text-dim)]">
                  {row.phase}
                </span>
                <span className="text-[14px] font-medium text-[var(--home-text)]">{row.title}</span>
                <span className="text-[12.5px] leading-relaxed text-[var(--home-text-faint)]">
                  {row.detail}
                </span>
                <span className="justify-self-start md:justify-self-auto">
                  <Chip tone={row.status === "Delivered" ? "accent" : "default"}>
                    {row.status === "Delivered" ? "✓ delivered" : row.status}
                  </Chip>
                </span>
              </div>
            ))}
          </Frame>
        </Reveal>
        <Reveal delay={120}>
          <p className="mt-6 max-w-[720px] text-[13px] leading-relaxed text-[var(--home-text-faint)]">
            Explicitly out of scope for now: memory stores, retrieval, code sandboxes, multi-agent
            orchestration and marketplace mechanics. Their boundaries exist in the architecture, but
            none of them are built — the runtime stays the thing being engineered.
          </p>
        </Reveal>
      </Section>

      {/* Closing CTA -------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden border-t border-[var(--home-border)]">
        <Starfield
          className="absolute inset-0 h-full w-full opacity-80"
          density={0.00026}
          maxRadius={1.15}
        />
        <Aurora className="opacity-80" />
        <div aria-hidden="true" className="landing-noise pointer-events-none absolute inset-0" />
        <Container className="relative z-10 flex flex-col items-start gap-8 py-24 md:py-32">
          <Reveal className="flex flex-col items-start">
            <p className="landing-eyebrow"># Start here</p>
            <h2 className="landing-display mt-5 max-w-[22ch] text-[clamp(30px,4.4vw,58px)]">
              Your agent&apos;s behaviour should be a{" "}
              <span className="landing-gradient-text">versioned artifact</span>.
            </h2>
            <p className="mt-6 max-w-[560px] text-[15px] leading-relaxed text-[var(--home-text-secondary)]">
              Create an agent, design its harness, publish a version and watch the trace come back
              node by node.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-x-8 gap-y-4">
              <Link
                href="/login"
                className="bg-white px-6 py-3 text-[14px] font-medium text-black transition-opacity hover:opacity-85"
              >
                Start building
              </Link>
              <ArrowLink href="/dashboard">Open the dashboard</ArrowLink>
            </div>
          </Reveal>
        </Container>

        {/*
         * The closing mark: the wordmark set to the width of the viewport, faint,
         * with its bottom third sliced off by the section's own edge — the last
         * thing drawn before the footer. The size is in `vw` because the mark is
         * meant to span the screen (eight characters, so a quarter of the width
         * per em); `translate-y` hangs it below the clipping box, and nothing
         * above can be covered: it is at 7.5% opacity and behind the content.
         */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 flex select-none justify-center overflow-hidden"
        >
          <span
            style={{ fontSize: "clamp(72px, 25vw, 560px)" }}
            className="translate-y-[32%] font-bold lowercase leading-none tracking-[-0.03em] text-[var(--home-text)] opacity-[0.075]"
          >
            orqestra
          </span>
        </div>
      </section>

      {/*
       * Footer --------------------------------------------------------------
       *
       * Inset to its own measure rather than the page's — the last block on the
       * page reads as a colophon, not as another section: eight slots across,
       * small type, one footnote, and a bar of quiet links at the foot.
       */}
      <footer className="border-t border-[var(--home-border)]">
        <div className="mx-auto w-full max-w-[1100px] px-6 pt-16 pb-8 md:pt-20">
          {/* Brand over two slots, then one column per group: eight in all. */}
          <div className="grid grid-cols-2 gap-10 pb-16 md:grid-cols-4 lg:grid-cols-8">
            <div className="col-span-2 min-w-0 md:col-span-1">
              <Link
                href="/"
                className="flex items-center gap-2 font-bold tracking-tight no-underline"
              >
                <OrqestraMark className="h-6 w-6 text-[var(--home-text)]" />
                <span className="text-[16px] leading-none">orqestra</span>
              </Link>
              <p className="mt-3 max-w-[200px] text-sm leading-relaxed text-[var(--home-text-faint)]">
                The model provides intelligence. The harness controls behavior.
              </p>{" "}
            </div>

            {FOOTER_COLUMNS.map((column) => (
              <nav key={column.title} aria-label={column.title} className="min-w-0">
                <h2 className="mb-4 text-[14px] font-semibold text-[var(--home-text-secondary)]">
                  {column.title}
                </h2>
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-[14px] text-[var(--home-text-faint)] transition-colors hover:text-[var(--home-text-secondary)]"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
          {/*
           * The small print, in the reference's manner: one line of it, kept to a
           * readable measure, saying the thing a visitor should know about the
           * numbers above — that they are this repository's own, not a vendor's.
           */}{" "}
          <p className="mb-6 max-w-[720px] text-[11px] leading-relaxed text-[var(--home-text-faint)]">
            * Every figure quoted on this page comes from a run of this repository&apos;s own
            runtime: the compiler, executor, trace and usage accounting live in{" "}
            <span className="landing-mono text-[10.5px]">src/modules/runtime</span>. Nothing here is
            a hosted service&apos;s benchmark.
          </p>
          <div className="flex flex-col gap-4 border-t border-[var(--home-border)] pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-[var(--home-text-faint)]">
              © 2026 Orqestra · harness engineering platform · license not yet specified
            </p>
            <div className="flex items-center gap-4">
              <FooterIconLink href="/dashboard" label="Open the dashboard">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </FooterIconLink>
              <FooterIconLink href="/dashboard/runs" label="See the runs">
                <path d="M3 12h3.5l2.5-6 3.5 12 3-8 1.5 2H21" />
              </FooterIconLink>
              <FooterIconLink href="/api/health" label="Check system health">
                <path d="M12 21s-7-4.6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.4-7 10-7 10Z" />
                <path d="M7 12h2.5l1.5-2 2 4 1.5-2H17" />
              </FooterIconLink>
              <FooterIconLink href="#top" label="Back to the top">
                <path d="M12 20V5" />
                <path d="M6 11l6-6 6 6" />
              </FooterIconLink>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * A footer control: a mark with a name, quiet until it is pointed at.
 *
 * The icon carries no visible text — `label` is what a screen reader and a
 * tooltip announce — so the group reads as a row of controls rather than a
 * second navigation competing with the columns above.
 */
function FooterIconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      data-footer-control=""
      className="text-[var(--home-text-faint)] transition-colors hover:text-[var(--home-text-secondary)]"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[18px] w-[18px]"
      >
        {children}
      </svg>
    </Link>
  );
}
