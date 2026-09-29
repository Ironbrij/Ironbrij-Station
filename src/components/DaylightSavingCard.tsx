import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { Clock, Mail } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import { formatEmailDate } from "@/lib/email-template";
import type { DstResponse } from "@/lib/dst-response";

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
 * Clients whose clocks change in the next three weeks, and a button to email
 * them each VA's hours before and after. Nothing is sent until the admin asks.
 */
export function DaylightSavingCard() {
  const { user } = useAuth();
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
      </div>

      {clients === null ? (
        <p className="text-xs text-muted-foreground">Checking client clocks…</p>
      ) : clients.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No client&apos;s clocks change in the next three weeks, or those clients have no client
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
                {answer.decision === "keep" && (
                  <div className="font-medium text-violet-800 dark:text-violet-300">
                    Update in SavyTime:{" "}
                    {answer.lines
                      .map((line) => `${line.name} to ${line.clientKeep} (client's clock)`)
                      .join("; ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
