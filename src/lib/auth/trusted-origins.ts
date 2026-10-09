import type { Env } from "@/config/env";

/**
 * Origin policy for the auth API, shared by both providers.
 *
 * The allowlist is the same in both directions:
 *
 *  - `better-auth` (self-hosted) passes it to Better Auth as `trustedOrigins`;
 *  - the Neon Auth proxy validates the browser's Origin against it and then
 *    rewrites the header to `APP_URL`, the origin registered with the hosted
 *    instance (which cannot know about local dev ports).
 *
 * Production stays strict: APP_URL plus explicitly configured origins.
 * Development additionally trusts any loopback port, because Next.js picks a
 * free port whenever 3000 is busy and Playwright runs the build on its own.
 */
export function resolveTrustedOrigins(env: Env): string[] {
  const origins = new Set<string>([env.APP_URL]);
  for (const origin of env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")) {
    const trimmed = origin.trim();
    if (trimmed !== "") {
      origins.add(trimmed);
    }
  }
  if (env.NODE_ENV !== "production") {
    origins.add("http://localhost:*");
    origins.add("http://127.0.0.1:*");
  }
  return [...origins];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `origin` matches one of the patterns. Patterns may contain `*` as
 * a wildcard (e.g. `http://localhost:*`), mirroring Better Auth semantics.
 */
export function isOriginTrusted(origin: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === origin) {
      return true;
    }
    if (!pattern.includes("*")) {
      return false;
    }
    const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
    return regex.test(origin);
  });
}
