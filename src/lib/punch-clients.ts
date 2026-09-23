import type { Punch } from "./types.ts";
import { toMillis } from "./time.ts";

export interface ClientPunchGroup {
  client: string;
  punches: Punch[];
}

/**
 * Splits one day's events per client. An employee who works for several clients
 * interleaves their clock-ins, so a flat list reads as one confusing sequence.
 * Groups keep each client's own order and appear by their first event of the day.
 */
export function groupPunchesByClient(
  punches: Punch[],
  clientNameOf: (punch: Punch) => string,
): ClientPunchGroup[] {
  const groups = new Map<string, Punch[]>();
  for (const punch of [...punches].sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))) {
    const client = clientNameOf(punch) || "Unassigned client";
    const existing = groups.get(client);
    if (existing) existing.push(punch);
    else groups.set(client, [punch]);
  }
  return [...groups].map(([client, list]) => ({ client, punches: list }));
}
