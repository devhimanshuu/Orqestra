/**
 * Authentication abstraction.
 *
 * The application depends only on this interface; Better Auth is one
 * implementation (see better-auth.provider.ts). Swapping auth systems later
 * means adding a provider — not touching services, pages, or routes.
 */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: Date;
}

export interface AuthSessionInfo {
  id: string;
  expiresAt: Date;
}

export interface AuthSession {
  user: AuthUser;
  session: AuthSessionInfo;
}

export interface AuthProvider {
  /** Stable identifier, e.g. "better-auth". */
  readonly id: string;
  /** Handles the provider's HTTP routes (mounted at /api/auth/*). */
  handleRequest(request: Request): Promise<Response>;
  /** Resolves the current session from incoming request headers, or null. */
  getSession(headers: Headers): Promise<AuthSession | null>;
}
