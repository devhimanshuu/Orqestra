import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import { LandingPage } from "@/components/landing/landing-page";

/**
 * Marketing landing page.
 *
 * The page loads its own display face (Space Grotesk) and scopes it to the
 * `.landing` wrapper, so the dashboard and the builder keep the app's Geist
 * typography. Everything below the wrapper is a server component.
 */

const spaceGrotesk = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Orqestra — harness engineering infrastructure",
  description:
    "The model provides intelligence. The harness controls behavior. Design, compile, execute and trace AI-agent behaviour as versioned graphs.",
  openGraph: {
    title: "Orqestra — harness engineering infrastructure",
    description:
      "Versioned harnesses, a compiler, a runtime and a trace for every run. The model provides intelligence; the harness controls behavior.",
    type: "website",
  },
};

export default function HomePage() {
  return (
    <div className={spaceGrotesk.variable}>
      <LandingPage />
    </div>
  );
}
