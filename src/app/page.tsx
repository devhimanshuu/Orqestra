import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const PIPELINE = [
  "Agent",
  "Harness Definition",
  "Harness Compiler",
  "Execution Plan",
  "Agent Runtime",
  "Tools · Memory · Context · Loops",
  "LLM",
  "Evaluation",
  "Trace",
  "Experiment",
  "Harness Optimization",
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-4xl font-semibold tracking-tight">Orqestra</h1>
          <Badge variant="secondary">Phase 0</Badge>
        </div>
        <p className="max-w-2xl text-lg text-muted-foreground">
          A platform for engineering, executing, evaluating, and eventually evolving AI-agent
          harnesses. The LLM is one component — the harness controls how an agent behaves.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/dashboard">Open dashboard</Link>
          </Button>
          <Button asChild variant="outline">
            <a href="/api/health">System health</a>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Agent vs Harness</CardTitle>
          <CardDescription>
            The two concepts are deliberately separate — and never merged into one object.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Agent — who it is</h3>
            <p className="text-sm text-muted-foreground">
              Identity, purpose, goal, base instructions, model configuration, available
              capabilities.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="font-medium">Harness — how it behaves</h3>
            <p className="text-sm text-muted-foreground">
              Reasoning flow, tool use, memory, context construction, loops, failure handling,
              evaluation, termination.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Long-term architecture</CardTitle>
          <CardDescription>Phase 0 establishes every boundary this pipeline needs.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-wrap gap-2 text-sm text-muted-foreground">
            {PIPELINE.map((step) => (
              <li key={step} className="rounded-md border border-border px-2 py-1">
                {step}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <footer className="text-sm text-muted-foreground">
        <span>
          Phase 0 shell: Next.js · PostgreSQL · Prisma · Redis · BullMQ · Better Auth · Gemini /
          Ollama gateways.
        </span>
      </footer>
    </main>
  );
}
