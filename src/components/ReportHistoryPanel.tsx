import { useEffect, useMemo, useRef, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { Eye, History, Printer, X } from "lucide-react";
import { db } from "@/lib/firebase";
import { normalizeCompanyId } from "@/lib/company-context";
import { formatEmailDate } from "@/lib/email-template";
import { buildReportEmail } from "@/lib/report-email";
import type { ReportHistoryEntry } from "@/lib/report-history";
import type { Company } from "@/lib/types";

/**
 * Every report that was sent, week by week, to open again exactly as it went
 * out. Filled by the Send button and the weekly automation.
 */
export function ReportHistoryPanel({
  companies,
  initialCompany,
}: {
  companies: Company[];
  initialCompany: string;
}) {
  const [entries, setEntries] = useState<(ReportHistoryEntry & { id: string })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "all" on the Reports page means every company, so start with every company.
  const [company, setCompany] = useState(
    initialCompany && initialCompany !== "all" ? initialCompany : "all-companies",
  );
  const [open, setOpen] = useState<(ReportHistoryEntry & { id: string }) | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(
    () =>
      onSnapshot(
        query(collection(db(), "reportHistory"), orderBy("sentAt", "desc"), limit(1000)),
        (snapshot) => {
          setError(null);
          setEntries(
            snapshot.docs.map((item) => ({ ...(item.data() as ReportHistoryEntry), id: item.id })),
          );
        },
        (failure) => {
          setError(failure.message);
          setEntries([]);
        },
      ),
    [],
  );

  const shown = useMemo(
    () =>
      (entries ?? []).filter(
        (entry) =>
          company === "all-companies" ||
          normalizeCompanyId(entry.companyId) === normalizeCompanyId(company),
      ),
    [entries, company],
  );

  // One group per week covered, newest first.
  const weeks = useMemo(() => {
    const groups = new Map<string, (ReportHistoryEntry & { id: string })[]>();
    for (const entry of shown) {
      const key = `${entry.from}|${entry.to}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [shown]);

  const html = useMemo(() => (open ? buildReportEmail(open.report, open.sentBy).html : ""), [open]);

  const sentAt = (value: string) =>
    new Date(value).toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="font-bold text-primary flex items-center gap-2">
            <History className="h-4 w-4" /> Sent reports history
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every report sent to a client, kept as it was sent. Open one to see it again, or print
            it to save as a PDF.
          </p>
        </div>
        <label className="text-xs font-bold text-muted-foreground">
          Company
          <select
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            className="mt-1 block w-full sm:w-64 rounded-md border bg-background px-2.5 py-1.5 text-sm font-medium text-foreground"
          >
            <option value="all-companies">Every company</option>
            <option value="all">All-clients report</option>
            {companies
              .filter((item) => item.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="text-xs font-medium text-destructive">
          The history could not be loaded: {error}
        </p>
      )}
      {entries === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : weeks.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          No reports sent yet{company === "all-companies" ? "" : " for this company"}. Reports
          appear here from the next time one is sent.
        </p>
      ) : (
        <div className="space-y-4">
          {weeks.map(([key, list]) => {
            const [from, to] = key.split("|");
            return (
              <div key={key} className="space-y-1.5">
                <div className="text-xs font-bold text-foreground">
                  {from && to
                    ? `${formatEmailDate(from)} to ${formatEmailDate(to)}`
                    : list[0].periodLabel}
                </div>
                <div className="divide-y rounded-md border">
                  {list.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold">{entry.companyName}</div>
                        <div className="text-[11px] text-muted-foreground">
                          Sent {sentAt(entry.sentAt)} by {entry.sentBy} · to{" "}
                          {entry.recipients.join(", ")}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {entry.totalEmployees} {entry.totalEmployees === 1 ? "person" : "people"}{" "}
                          · {entry.totalHours}h regular · {entry.totalOvertime}h overtime
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setOpen(entry)}
                        className="rounded-md border px-3 py-1.5 text-xs font-bold text-primary hover:bg-muted flex items-center gap-1.5"
                      >
                        <Eye className="h-3.5 w-3.5" /> View
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex h-[90vh] w-full max-w-6xl flex-col rounded-xl border bg-card shadow-lift">
            <div className="flex items-center justify-between gap-3 border-b p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{open.subject}</div>
                <div className="text-[11px] text-muted-foreground">
                  Sent {sentAt(open.sentAt)} by {open.sentBy} to {open.recipients.join(", ")}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={() => frame.current?.contentWindow?.print()}
                  className="rounded-md border px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 hover:bg-muted"
                >
                  <Printer className="h-3.5 w-3.5" /> Print / save as PDF
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(null)}
                  className="rounded-md p-1.5 hover:bg-muted"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe
              ref={frame}
              title="Sent report"
              srcDoc={html}
              sandbox="allow-same-origin allow-modals"
              className="w-full flex-1 rounded-b-xl bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}
