import { ValidationFailedError } from "@/lib/errors";

/** Reads a JSON body, converting malformed input into a 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new ValidationFailedError("Request body must be valid JSON");
  }
}

export function readQuery(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

/** Parses a request body with a Zod schema (throws ZodError → 400 by the error mapper). */
export async function readJsonWith<T>(
  request: Request,
  parser: { parse: (input: unknown) => T },
): Promise<T> {
  return parser.parse(await readJson(request));
}
