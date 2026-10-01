import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { Clock, Mail } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { formatEmailDate } from "@/lib/email-template";
import type { DstResponse } from "@/lib/dst-response";
import type { Company, Employee } from "@/lib/types";
import { DstScheduleView } from "@/components/DstScheduleView";
import { updateIfUnchanged } from "@/lib/guarded-writes";
import { chosenClockUpdate, linesToApply } from "@/lib/shift-clock";

const SHIFT_FIELDS = [
  "shiftTimezone",
  "shiftStartTime",
  "shiftEndTime",
  "shifts",
  "companyMemberships",
] as const;

interface DstClient {
  companyId: string;
  companyName: string;
  to: string[];
  date: string;
  dateLabel: string;
  kind: "start" | "end";
  timezone: string;
  vas: number;
}

/**
 * Clients whose clocks change in the next five weeks, and a button to email
 * them each VA's hours before and after. Nothing is sent until the admin asks.
 * The full year's schedule for every client opens from here too.
 */
export function DaylightSavingCard({
  companies,
  employees,
}: {
  companies: Company[];
  employees: Employee[];
}) {
  const { user } = useAuth();
  const [showSchedule, setShowSchedule] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);

  /** Re-saves each VA's shift on the clock the client chose, then marks the choice applied. */
  async function applyChoice(answer: DstResponse & { id: string }) {
    if (!answer.decision) return;
    setApplying(answer.id);
    try {
      let changed = 0;
      for (const [employeeId, lines] of linesToApply(answer.lines, answer.decision)) {
        const employee = employees.find((item) => item.id === employeeId);
        if (!employee) continue;
        const update = chosenClockUpdate(
          employee,
          answer.companyId,
          lines,
          answer.change.timezone,
          answer.decision,
        );
        if (!update) continue;
        await updateIfUnchanged({
          path: `employees/${employeeId}`,
          baseline: employee as unknown as Record<string, unknown>,
          watched: SHIFT_FIELDS,
          what: `${employee.name || "This VA"}'s shift`,
          update: { ...update, updatedAt: new Date().toISOString() },
        });
        changed += 1;
      }
      await updateDoc(doc(db(), "dstResponses", answer.id), {
        appliedAt: new Date().toISOString(),
        appliedBy: user?.email || "Admin",
      });
      toast.success(
        changed
          ? `Updated ${changed} ${changed === 1 ? "VA's shift" : "VAs' shifts"} for ${answer.companyName}.`
          : `Nothing needed changing for ${answer.companyName}.`,
      );
    } catch (error) {
      toast.error((error as Error).message || "The shifts could not be updated.");
    } finally {
      setApplying(null);
    }
  }
  const [clients, setClients] = useState<DstClient[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [answers, setAnswers] = useState<(DstResponse & { id: string })[]>([]);

  // Each client's choice, for changes still to come.
  useEffect(
    () =>
      onSnapshot(
        collection(db(), "dstResponses"),
        (snapshot) =>
          setAnswers(
            snapshot.docs.map((item) => ({ ...(item.data() as DstResponse), id: item.id })),
          ),
        () => setAnswers([]),
      ),
    [],
  );
  const today = new Date().toISOString().slice(0, 10);
  const upcomingAnswers = answers
    .filter((answer) => answer.change?.date >= today)
    .sort(
      (a, b) =>
        a.change.date.localeCompare(b.change.date) || a.companyName.localeCompare(b.companyName),
    );

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/dst-notification", {
          method: "POST",
          headers: {
            authorization: `Bearer ${await user.getIdToken()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ dryRun: true }),
        });
        const result = (await response.json().catch(() => ({}))) as { clients?: DstClient[] };
        if (cancelled) return;
        const list = response.ok ? (result.clients ?? []) : [];
        setClients(list);
        setPicked(new Set(list.map((client) => client.companyId)));
      } catch {
        if (!cancelled) setClients([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function send() {
    if (!user || picked.size === 0) return;
    setSending(true);
    try {
      const response = await fetch("/api/dst-notification", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await user.getIdToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ companyIds: [...picked] }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        sent?: number;
        failed?: number;
        vas?: number;
        error?: string;
      };
      if (!response.ok) {
        toast.error(result.error || "The daylight saving emails could not be sent.");
      } else {
        toast.success(
          `Emailed ${result.sent ?? 0} ${result.sent === 1 ? "client" : "clients"}` +
            (result.vas ? ` and ${result.vas} ${result.vas === 1 ? "VA" : "VAs"}` : "") +
            ". VAs are emailed once their client chooses." +
            (result.failed ? ` (${result.failed} could not be sent)` : ""),
        );
        setPicked(new Set());
      }
    } catch {
      toast.error("The daylight saving emails could not be sent.");
    } finally {
      setSending(false);
    }
  }

  function toggle(companyId: string) {
    const next = new Set(picked);
    if (next.has(companyId)) next.delete(companyId);
    else next.add(companyId);
    setPicked(next);
  }

  return (
    <div className="rounded-xl border bg-card p-5 sm:p-6 shadow-lift space-y-4">
      <div>
        <h2 className="font-bold text-primary flex items-center gap-2">
          <Clock className="h-4 w-4" /> Daylight saving
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Before a client&apos;s clocks move, email them their VAs&apos; hours under both choices:
          follow the client&apos;s new DST schedule, or keep the VA&apos;s current schedule. The
          client picks one from the email; the VA and you are told automatically.
        </p>
        <button
          type="button"
          onClick={() => setShowSchedule(true)}
          className="mt-2 rounded-md border px-3 py-1.5 text-xs font-bold text-primary hover:bg-muted"
        >
          See every client&apos;s daylight saving schedule
        </button>
      </div>
      {showSchedule && (
        <DstScheduleView
          companies={companies}
          employees={employees}
          onClose={() => setShowSchedule(false)}
        />
      )}

      {clients === null ? (
        <p className="text-xs text-muted-foreground">Checking client clocks…</p>
      ) : clients.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No client&apos;s clocks change in the next five weeks, or those clients have no client
          email with Daylight saving switched on.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {clients.map((client) => (
              <label
                key={client.companyId}
                className="flex items-start gap-2 rounded-md border p-2.5 text-sm cursor-pointer"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.has(client.companyId)}
                  onChange={() => toggle(client.companyId)}
                />
                <span className="min-w-0">
                  <span className="font-semibold">{client.companyName}</span>
                  <span className="block text-xs text-muted-foreground">
                    Daylight saving {client.kind === "start" ? "starts" : "ends"} {client.dateLabel}{" "}
                    ({client.timezone}) · {client.vas} {client.vas === 1 ? "VA" : "VAs"} · to{" "}
                    {client.to.join(", ")}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={send}
            disabled={sending || picked.size === 0}
            className="btn-lift rounded-md bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground flex items-center gap-1.5 disabled:opacity-50"
          >
            <Mail className="h-3.5 w-3.5" />
            {sending
              ? "Sending…"
              : `Email ${picked.size} ${picked.size === 1 ? "client" : "clients"}`}
          </button>
        </>
      )}

      {upcomingAnswers.length > 0 && (
        <div className="space-y-1.5 border-t pt-3">
          <div className="text-xs font-bold">Client choices</div>
          <div className="divide-y rounded-md border">
            {upcomingAnswers.map((answer) => (
              <div key={answer.id} className="p-2.5 text-xs space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-sm">{answer.companyName}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-bold ${
                      answer.decision === "follow"
                        ? "bg-cyan-500/15 text-cyan-800"
                        : answer.decision === "keep"
                          ? "bg-violet-500/15 text-violet-800"
                          : "bg-amber-500/15 text-amber-700"
                    }`}
                  >
                    {answer.decision === "follow"
                      ? "Follow new DST schedule"
                      : answer.decision === "keep"
                        ? answer.keepLabel
                        : "Waiting for answer"}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {answer.change.kind === "start" ? "Starts" : "Ends"}{" "}
                  {formatEmailDate(answer.change.date)} ·{" "}
                  {[...new Set(answer.lines.map((line) => line.name))].join(", ")}
                </div>
                {answer.decision &&
                  (linesToApply(answer.lines, answer.decision).size === 0 ? (
                    <div className="font-medium text-emerald-700 dark:text-emerald-400">
                      Nothing to change: SavyTime gives these hours by itself.
                    </div>
                  ) : answer.appliedAt ? (
                    <div className="font-medium text-emerald-700 dark:text-emerald-400">
                      Applied in SavyTime by {answer.appliedBy || "an admin"}: the shifts now follow
                      the chosen clock.
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-amber-700 dark:text-amber-400">
                        Not in SavyTime yet:{" "}
                        {answer.lines
                          .map(
                            (line) =>
                              `${line.name} ${answer.decision === "follow" ? line.clientAfter : line.clientKeep}`,
                          )
                          .join("; ")}{" "}
                        on the client&apos;s clock
                      </span>
                      <button
                        type="button"
                        disabled={applying === answer.id}
                        onClick={() => applyChoice(answer)}
                        className="btn-lift rounded-md bg-primary px-3 py-1 text-xs font-bold text-primary-foreground disabled:opacity-50"
                      >
                        {applying === answer.id ? "Applying…" : "Apply"}
                      </button>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
