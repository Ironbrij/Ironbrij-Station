import { useMemo } from "react";
import { AlertTriangle, X } from "lucide-react";
import { formatEmailDate } from "@/lib/email-template";
import { clockGap, planDstSchedule, placeName, type DstScheduleEntry } from "@/lib/dst-email";
import { companyState, regionLabel } from "@/lib/holidays";
import type { Company, Employee } from "@/lib/types";

const VA_CLOCKS = [
  { timezone: "Asia/Manila", label: "Philippines" },
  { timezone: "Asia/Kathmandu", label: "Nepal" },
];

function dayAround(dateKey: string, days: number): Date {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

/** "2h → 3h ahead": the client's clock against a VA's, before and after the change. */
function gapChange(entry: DstScheduleEntry, vaTimezone: string): string {
  const short = (text: string) =>
    text.replace(" hours", "h").replace(" hour", "h").replace(" minutes", "m");
  if (!entry.change) return short(clockGap(entry.timezone, vaTimezone, new Date()));
  const before = short(clockGap(entry.timezone, vaTimezone, dayAround(entry.change.date, -1)));
  const after = short(clockGap(entry.timezone, vaTimezone, dayAround(entry.change.date, 1)));
  return `${before.replace(/ (ahead of|behind)$/, "")} → ${after}`;
}

const AUTOMATIC = {
  follow: { text: "Follows the client by itself", tone: "text-cyan-800 dark:text-cyan-300" },
  keep: { text: "Keeps the VA's hours by itself", tone: "text-violet-800 dark:text-violet-300" },
  neither: {
    text: "Saved on another clock: check the shift timezone",
    tone: "text-amber-700 dark:text-amber-400",
  },
} as const;

/**
 * Every client's clock for the year ahead: when it changes, how the gap to the
 * Philippines and Nepal moves, and each VA's hours before and after under
 * both choices. Worked out from the clocks themselves, so it holds for any
 * client region and however each shift is saved.
 */
export function DstScheduleView({
  companies,
  employees,
  onClose,
}: {
  companies: Company[];
  employees: Employee[];
  onClose: () => void;
}) {
  const entries = useMemo(
    () => planDstSchedule(companies, employees, new Date(), 366),
    [companies, employees],
  );
  const changing = entries.filter((entry) => entry.change);
  const location = (entry: DstScheduleEntry) => {
    const state = companyState(entry.company);
    return state ? regionLabel(state) : `${placeName(entry.timezone)} (no state set)`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-6">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border bg-card shadow-lift">
        <div className="flex items-start justify-between gap-3 border-b p-4">
          <div>
            <h2 className="text-lg font-bold text-primary">Daylight saving schedule</h2>
            <p className="text-xs text-muted-foreground">
              Every client&apos;s next clock change in the year ahead, and each VA&apos;s hours
              before and after. The Philippines and Nepal never change their clocks; the gap to the
              client does.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-muted"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto p-4">
          <section className="space-y-2">
            <h3 className="text-sm font-bold">When each client&apos;s clocks change</h3>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="p-2">Client</th>
                    <th className="p-2">Location</th>
                    <th className="p-2">Next change</th>
                    {VA_CLOCKS.map((clock) => (
                      <th key={clock.timezone} className="p-2">
                        Ahead of {clock.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {entries.map((entry) => (
                    <tr key={entry.company.id || entry.company.name}>
                      <td className="p-2 font-semibold">{entry.company.name}</td>
                      <td className="p-2">
                        <span
                          className={
                            companyState(entry.company) ? "" : "text-amber-700 dark:text-amber-400"
                          }
                        >
                          {location(entry)}
                        </span>
                      </td>
                      <td className="p-2">
                        {entry.change ? (
                          <>
                            <span className="font-semibold">
                              {entry.change.kind === "start" ? "Starts" : "Ends"}{" "}
                              {formatEmailDate(entry.change.date)}
                            </span>
                            <span className="block text-muted-foreground">
                              Clocks go {entry.change.kind === "start" ? "forward" : "back"} 1 hour
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">No daylight saving</span>
                        )}
                      </td>
                      {VA_CLOCKS.map((clock) => (
                        <td key={clock.timezone} className="p-2 font-mono">
                          {gapChange(entry, clock.timezone)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {changing.map((entry) => (
            <section key={entry.company.id || entry.company.name} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-bold">
                  {entry.company.name} · {location(entry)}
                </h3>
                <span className="text-xs text-muted-foreground">
                  Daylight saving {entry.change!.kind === "start" ? "starts" : "ends"}{" "}
                  {formatEmailDate(entry.change!.date)}
                  {entry.to.length === 0 && " · no client email for daylight saving"}
                </span>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full min-w-[860px] text-left text-xs">
                  <thead className="bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="p-2">VA</th>
                      <th className="p-2">Now</th>
                      <th className="p-2">Follow the client&apos;s new clock</th>
                      <th className="p-2">Keep the VA&apos;s hours</th>
                      <th className="p-2">In SavyTime</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {entry.schedules.map((line, index) => (
                      <tr key={`${line.id}-${index}`}>
                        <td className="p-2 font-semibold">{line.name}</td>
                        <td className="p-2">
                          {line.clientBefore}
                          <span className="block text-muted-foreground">
                            {line.vaBefore} {line.vaZone}
                          </span>
                        </td>
                        <td className="p-2">
                          {line.clientAfter}
                          <span className="block font-semibold text-cyan-800 dark:text-cyan-300">
                            {line.vaAfter} {line.vaZone}
                          </span>
                        </td>
                        <td className="p-2">
                          <span className="font-semibold text-violet-800 dark:text-violet-300">
                            {line.clientKeep}
                          </span>
                          <span className="block text-muted-foreground">
                            {line.vaBefore} {line.vaZone}
                          </span>
                        </td>
                        <td className={`p-2 ${AUTOMATIC[line.automatic].tone}`}>
                          {line.automatic === "neither" && (
                            <AlertTriangle className="mr-1 inline h-3 w-3" />
                          )}
                          {AUTOMATIC[line.automatic].text}
                          <span className="block text-muted-foreground">
                            Saved on {line.savedZone}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {entry.unscheduled.map((name) => (
                      <tr key={name}>
                        <td className="p-2 font-semibold">{name}</td>
                        <td className="p-2 text-amber-700 dark:text-amber-400" colSpan={4}>
                          No shift times saved for this client
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          {entries.length === 0 && (
            <p className="text-xs text-muted-foreground">No active clients with active VAs.</p>
          )}
        </div>
      </div>
    </div>
  );
}
