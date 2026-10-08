import { getEnv } from "@/config/env";
import { BetterAuthProvider } from "./better-auth.provider";
import { NeonAuthProvider } from "./neon-auth.provider";
import type { AuthProvider } from "./provider";

export type { AuthProvider, AuthSession, AuthSessionInfo, AuthUser } from "./provider";

let provider: AuthProvider | undefined;

/**
 * Lazy auth provider accessor — swap implementations here.
 *
 * Selection rule: when AUTH_URL is configured, auth runs on Neon's hosted
 * Better Auth instance (NeonAuthProvider proxies /api/auth/* to it). Without
 * AUTH_URL the app falls back to self-hosted Better Auth (BetterAuthProvider).
 */
export function getAuthProvider(): AuthProvider {
  if (provider === undefined) {
    provider = getEnv().AUTH_URL !== "" ? new NeonAuthProvider() : new BetterAuthProvider();
  }
  return provider;
}
