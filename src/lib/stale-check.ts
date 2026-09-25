/**
 * Which of the watched fields differ between what a form opened with and what
 * is saved now. Missing, null and undefined all read as "not set", and objects
 * compare by content whatever order their keys were saved in.
 */
export function changedFields(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
  watched: readonly string[],
): string[] {
  return watched.filter((field) => canonical(baseline[field]) !== canonical(current[field]));
}

function canonical(value: unknown): string {
  return JSON.stringify(normalise(value)) ?? "null";
}

function normalise(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    const maybeTimestamp = value as { toMillis?: () => number };
    if (typeof maybeTimestamp.toMillis === "function") return maybeTimestamp.toMillis();
    if (value instanceof Date) return value.getTime();
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, normalise((value as Record<string, unknown>)[key])])
        .filter(([, item]) => item !== null),
    );
  }
  return value;
}
