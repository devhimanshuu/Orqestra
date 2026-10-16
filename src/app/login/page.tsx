import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Space_Grotesk } from "next/font/google";
import { Suspense } from "react";
import { OrqestraMark } from "@/components/brand/orqestra-mark";
import { ClosingMark } from "@/components/landing/closing-mark";
import { InteractiveSweep } from "@/components/landing/interactive-sweep";
import { ArrowLink, Container } from "@/components/landing/primitives";
import { Starfield } from "@/components/landing/starfield";
import { LoginForm } from "@/components/login-form";
import { getAuthProvider } from "@/lib/auth";
import { getEnv } from "@/config/env";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * The sign-in page is part of the marketing surface, so it wears the landing
 * page's design: the same black canvas, star field, line artwork, noise,
 * header lockup and display typography — all scoped under `.landing`, which
 * carries the palette and faces (see `globals.css`). The Space Grotesk display
 * face is loaded here the same way `/` loads it.
 */

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

/**
 * Session reads are request-dependent, so they stream inside a Suspense
 * boundary (required by Next 16 Cache Components).
 */
async function RedirectIfSignedIn(): Promise<null> {
  const session = await getAuthProvider().getSession(await headers());
  if (session !== null) {
    redirect("/dashboard");
  }
  return null;
}

export default function LoginPage() {
  /*
   * Social sign-in availability, server-side only (booleans — no credentials
   * reach the client). Behind AUTH_URL the hosted Neon Auth instance owns its
   * own provider configuration, so the buttons are offered optimistically and
   * its answer is surfaced in the form's alert.
   */
  const env = getEnv();
  const hostedAuth = env.AUTH_URL !== "";
  const social = {
    github: hostedAuth || (env.GITHUB_CLIENT_ID !== "" && env.GITHUB_CLIENT_SECRET !== ""),
    google: hostedAuth || (env.GOOGLE_CLIENT_ID !== "" && env.GOOGLE_CLIENT_SECRET !== ""),
  };

  return (
    <div className={`${spaceGrotesk.variable} landing relative flex h-dvh flex-col overflow-hidden`}>
      <Suspense fallback={null}>
        <RedirectIfSignedIn />
      </Suspense>

      {/* The hero's base layers, verbatim: deep space, nebula, stars, line art, grain, vignette, fade. */}
      <div aria-hidden="true" className="landing-space pointer-events-none absolute inset-0" />
      <div aria-hidden="true" className="landing-nebula pointer-events-none absolute inset-0" />
      <Starfield
        className="landing-starfield-far pointer-events-none absolute inset-0 h-full w-full"
        density={0.00028}
        speed={0.5}
        maxRadius={0.9}
      />
      <Starfield
        className="pointer-events-none absolute inset-0 h-full w-full opacity-95"
        density={0.00045}
        maxRadius={1.15}
      />
      <InteractiveSweep />
      <div aria-hidden="true" className="landing-noise pointer-events-none absolute inset-0" />
      <div aria-hidden="true" className="landing-vignette pointer-events-none absolute inset-0" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[var(--home-bg)] to-transparent"
      />

      {/* The landing page's closing mark, shared so the two surfaces cannot drift. */}
      <ClosingMark />

      <header className="relative z-10 border-b border-[var(--home-border)] bg-[color-mix(in_oklab,var(--home-bg)_82%,transparent)] backdrop-blur-md">
        <Container className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 no-underline">
            <OrqestraMark animated className="h-7 w-7 text-[var(--home-text)]" />
            <span className="text-[22px] leading-none font-bold tracking-tight">orqestra</span>
          </Link>
          <ArrowLink href="/">Back to the landing page</ArrowLink>
        </Container>
      </header>

      {/*
       * Exactly one viewport tall, header included: `h-dvh` + `overflow-hidden`
       * on the root means the document itself can never scroll — no scrollbar,
       * no scroll scope — and this main fills whatever height the header leaves,
       * centering the card in it.
       */}
      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-4 md:py-6">
        <LoginForm social={social} />
      </main>
    </div>
  );
}
