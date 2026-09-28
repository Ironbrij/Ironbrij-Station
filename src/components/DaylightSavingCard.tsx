import { useEffect, useState } from "react";
import { Clock, Mail } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";

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
            ` and ${result.vas ?? 0} ${result.vas === 1 ? "VA" : "VAs"}` +
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
          When a client&apos;s clocks move, their VA works the same hours on the client&apos;s
          clock, so the VA&apos;s own start time moves by an hour. One click emails each client
          their VAs&apos; hours before and after, so they can reply if they want a change, and
          emails each VA their new start and finish times.
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
    </div>
  );
}
