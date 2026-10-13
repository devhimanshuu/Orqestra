"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Frame } from "@/components/landing/primitives";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth/client";

type Mode = "sign-in" | "sign-up";

/*
 * Landing vocabulary for form chrome: square hairline inputs, mono uppercase
 * labels, the white square submit the marketing page uses for its primary CTA.
 * The `cn` merge in the UI primitives lets these classes win over the rounded
 * app defaults without forking the components.
 */
const FIELD_CLASSES =
  "h-10 w-full rounded-none border border-[var(--home-border-strong)] bg-[var(--home-bg-elevated)] px-3.5 text-[14px] text-[var(--home-text)] placeholder:text-[var(--home-text-dim)] transition-colors outline-none focus-visible:border-[var(--home-violet)] focus-visible:ring-3 focus-visible:ring-[var(--home-violet)]/25";

const LABEL_CLASSES =
  "text-[10.5px] tracking-[0.14em] text-[var(--home-text-faint)] uppercase";

const SUBMIT_CLASSES =
  "h-10 w-full bg-white px-6 text-[14px] font-medium text-black transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-50";

const TOGGLE_CLASSES =
  "group inline-flex items-center gap-1.5 self-start text-[13.5px] text-[var(--home-text-secondary)] transition-colors hover:text-[var(--home-text)]";

/**
 * Thin UI over the auth client: no business logic, no direct provider calls —
 * it delegates to src/lib/auth/client and routes the user afterwards.
 *
 * Field names and the form's native submit path are deliberately intact: a cold
 * production server can answer before hydration, and the first click then falls
 * back to a native POST (see e2e/phase2.spec.ts).
 *
 * `social` is computed server-side (which providers have credentials) and
 * reaches the client as booleans only. An unconfigured provider is still
 * offered — clicking it explains which variables to set rather than failing at
 * a redirect to an OAuth app that does not exist.
 */
export function LoginForm({
  social,
}: {
  social: { github: boolean; google: boolean };
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSocial(provider: "github" | "google"): Promise<void> {
    const label = provider === "github" ? "GitHub" : "Google";
    if (!social[provider]) {
      setError(
        `${label} sign-in is not configured. Set ${provider.toUpperCase()}_CLIENT_ID and ${provider.toUpperCase()}_CLIENT_SECRET — or, with AUTH_URL set, enable ${label} on the hosted Neon Auth instance.`,
      );
      return;
    }

    setPending(true);
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: "/dashboard",
        errorCallbackURL: "/login",
        // In sign-up mode, ask the provider to create the account if it can.
        requestSignUp: mode === "sign-up",
      });
      if (result.error) {
        // The auth API answers with a code (e.g. PROVIDER_NOT_SUPPORTED) that
        // is the actionable half — surface it, never the empty generic.
        const detail = result.error.message || result.error.code;
        setError(detail ? `${label} sign-in failed: ${detail}` : `${label} sign-in failed`);
        setPending(false);
      }
      // On success the browser leaves for the provider; keep the button busy.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} sign-in failed`);
      setPending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              email,
              password,
              name: name.trim() === "" ? email : name.trim(),
            });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Frame
      tone="elevated"
      padded={false}
      className="login-card w-full max-w-[440px] border-[var(--home-border-strong)] bg-[color-mix(in_oklab,var(--home-bg-elevated)_82%,transparent)] p-5 backdrop-blur-md md:p-6"
    >
      <p className="landing-eyebrow"># Harness engineering platform</p>
      <h1 className="landing-display mt-3 text-[length:clamp(26px,4vw,36px)]">
        {mode === "sign-in" ? "Sign in" : "Create account"}
      </h1>
      {/*
       * The page never scrolls, so on a short or narrow viewport the pitch is
       * the first thing to go — the form is what must stay fully visible.
       */}
      <p className="mt-3 text-[13.5px] leading-snug text-[var(--home-text-secondary)] max-sm:hidden [@media(max-height:760px)]:hidden">
        {mode === "sign-in"
          ? "Use the seeded demo account or your own credentials. Every run, trace and evaluation lives behind this door."
          : "Email and password are stored in PostgreSQL via Better Auth."}
      </p>

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-5 flex flex-col gap-2.5">
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => void handleSocial("github")}
            className="flex h-10 items-center justify-center gap-2 border border-[var(--home-border-strong)] bg-[var(--home-bg-elevated)] text-[14px] text-[var(--home-text)] transition-colors hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-50"
          >
            <GitHubIcon />
            GitHub
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => void handleSocial("google")}
            className="flex h-10 items-center justify-center gap-2 border border-[var(--home-border-strong)] bg-[var(--home-bg-elevated)] text-[14px] text-[var(--home-text)] transition-colors hover:bg-white/[0.06] disabled:pointer-events-none disabled:opacity-50"
          >
            <GoogleIcon />
            Google
          </button>
        </div>

        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-[var(--home-border)]" />
          <span className="landing-mono text-[10px] tracking-[0.14em] text-[var(--home-text-dim)] uppercase">
            or continue with email
          </span>
          <span className="h-px flex-1 bg-[var(--home-border)]" />
        </div>

        {mode === "sign-up" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="name" className={LABEL_CLASSES}>
              Name
            </Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ada Lovelace"
              className={FIELD_CLASSES}
            />
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="email" className={LABEL_CLASSES}>
            Email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="demo@orqestra.dev"
            className={FIELD_CLASSES}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password" className={LABEL_CLASSES}>
            Password
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            className={FIELD_CLASSES}
          />
        </div>

        {error !== null && (
          <p
            role="alert"
            className="border border-[color-mix(in_oklab,var(--home-magenta)_40%,transparent)] bg-[color-mix(in_oklab,var(--home-magenta)_10%,transparent)] px-3 py-1.5 text-[12.5px] leading-snug text-[var(--home-magenta)]"
          >
            {error}
          </p>
        )}

        <button type="submit" disabled={pending} className={SUBMIT_CLASSES}>
          {pending ? "Working…" : mode === "sign-in" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
          }}
          className={TOGGLE_CLASSES}
        >
          {mode === "sign-in" ? "Need an account? Sign up" : "Have an account? Sign in"}
          <span aria-hidden="true" className="transition-transform duration-300 group-hover:translate-x-1">
            →
          </span>
        </button>

        <p className="landing-mono mt-1 border-t border-[var(--home-border)] pt-3 text-[10.5px] tracking-[0.12em] text-[var(--home-text-dim)] uppercase">
          {mode === "sign-in"
            ? "demo user · created by pnpm db:seed"
            : "passwords are hashed · postgres + better auth"}
        </p>
      </form>
    </Frame>
  );
}

/** Provider marks: lucide has no Google glyph and versions drift — inline. */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
