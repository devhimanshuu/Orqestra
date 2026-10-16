import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";

/**
 * True for the shared NotFoundError and for domain subclasses that signal a
 * missing resource without extending it (e.g. AgentNotFoundError).
 */
function isMissingResourceError(error: unknown): boolean {
  if (error instanceof NotFoundError) {
    return true;
  }
  return error instanceof Error && error.name.endsWith("NotFoundError");
}

/**
 * Await a service call from a server component; if the service reports the
 * resource as missing (or inaccessible — access checks also throw
 * NotFoundError), render the nearest not-found UI instead of crashing the
 * page. Every other error is rethrown so error boundaries still see it.
 */
export async function resolveOrNotFound<T>(fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch();
  } catch (error) {
    if (isMissingResourceError(error)) {
      notFound();
    }
    throw error;
  }
}
