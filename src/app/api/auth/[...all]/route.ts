import { getAuthProvider } from "@/lib/auth";

/**
 * /api/auth/* — delegated wholesale to the configured AuthProvider.
 * Swapping auth systems is a change in src/lib/auth, not in this route.
 */
export async function GET(request: Request): Promise<Response> {
  return getAuthProvider().handleRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return getAuthProvider().handleRequest(request);
}
