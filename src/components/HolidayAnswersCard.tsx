import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { MailQuestion } from "lucide-react";
import { db } from "@/lib/firebase";
import { formatEmailDate } from "@/lib/email-template";
import type { HolidayResponse } from "@/lib/holiday-response";

/**
 * Each client's answer to "will your VA work this holiday?", for the holidays
 * still to come, so the accounts team can see who is working and bill it.
 */
export function HolidayAnswersCard({ todayStr }: { todayStr: string }) {
  const [answers, setAnswers] = useState<(HolidayResponse & { id: string })[]>([]);

  useEffect(
    () =>
      onSnapshot(
        collection(db(), "holidayResponses"),
        (snapshot) =>
          setAnswers(
            snapshot.docs.map((item) => ({ ...(item.data() as HolidayResponse), id: item.id })),
          ),
        () => setAnswers([]),
      ),
    [],
  );

  const upcoming = answers
    .filter((answer) => answer.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date) || a.companyName.localeCompare(b.companyName));
  if (upcoming.length === 0) return null;

  return (
    <div className="rounded-xl border bg-card p-5 sm:p-6 shadow-lift space-y-3">
      <div>
        <h2 className="font-bold text-primary flex items-center gap-2">
          <MailQuestion className="h-4 w-4" /> Client holiday answers
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          What each client chose in their holiday email. A VA asked to work is emailed
          automatically; their hours are paid overtime.
        </p>
      </div>
      <div className="divide-y rounded-md border">
        {upcoming.map((answer) => (
          <div
            key={answer.id}
            className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-sm"
          >
            <div className="min-w-0">
              <div className="font-semibold">
                {answer.companyName} · {answer.holidayName}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatEmailDate(answer.date)} · {answer.vas?.map((va) => va.name).join(", ")}
              </div>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                answer.decision === "work"
                  ? "bg-emerald-500/15 text-emerald-700"
                  : answer.decision === "off"
                    ? "bg-slate-500/15 text-slate-700"
                    : "bg-amber-500/15 text-amber-700"
              }`}
            >
              {answer.decision === "work"
                ? "Work on holiday"
                : answer.decision === "off"
                  ? "Not working"
                  : "Waiting for answer"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
