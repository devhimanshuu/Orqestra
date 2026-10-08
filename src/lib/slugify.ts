/** URL-safe slug from a human name. Single implementation for all modules. */
export function slugify(value: string, maxLength = 60): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

/** Ensures a slug is never empty (e.g. a name in a non-latin script). */
export function slugifyOrDefault(value: string, fallback: string): string {
  const slug = slugify(value);
  return slug === "" ? fallback : slug;
}

/** Appends a numeric suffix to keep slugs unique-looking (`research-agent-2`). */
export function slugWithSuffix(value: string, suffix: string, maxLength = 60): string {
  const base = slugify(value, Math.max(1, maxLength - suffix.length - 1));
  return base === "" ? slugify(suffix) : `${base}-${slugify(suffix)}`;
}
