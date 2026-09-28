import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db, firebaseConfigured } from "@/lib/firebase";
import { formatEmailDate } from "@/lib/email-template";
import type { HolidayDecision, HolidayResponse } from "@/lib/holiday-response";

/**
 * Where a client's holiday email sends them. The button they pressed in the
 * email is picked already, but nothing is saved until they confirm here: mail
 * scanners open links on their own, and must never answer for the client.
 */

export const Route = createFileRoute("/holiday-response/$token")({
  validateSearch: (search: Record<string, unknown>): { choice?: HolidayDecision } =>
    search.choice === "work" || search.choice === "off" ? { choice: search.choice } : {},
  head: () => ({
    meta: [{ title: "Holiday answer — SavyTime" }, { name: "robots", content: "noindex" }],
  }),
  component: HolidayAnswer,
});

function HolidayAnswer() {
  const { token } = Route.useParams();
  const { choice: fromEmail } = Route.useSearch();
  const [question, setQuestion] = useState<HolidayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<HolidayDecision | undefined>(fromEmail);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<HolidayDecision | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!firebaseConfigured) {
      setError("This page is not available right now.");
      return;
    }
    getDoc(doc(db(), "holidayResponses", token))
      .then((snapshot) => {
        if (!snapshot.exists())
          setError("This link is not valid. Please reply to our email instead.");
        else setQuestion(snapshot.data() as HolidayResponse);
      })
      .catch(() =>
        setError("This page could not be loaded. Please try again, or reply to our email."),
      );
  }, [token]);

  async function confirm() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/holiday-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, decision: choice }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok)
        setError(result.error || "Your answer could not be saved. Please try again.");
      else setDone(choice);
    } catch {
      setError("Your answer could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const answered = done ?? question?.decision ?? null;
  const vaNames = question?.vas?.map((va) => va.name).join(", ") || "your Virtual Assistant";
  const option = (value: HolidayDecision, title: string, detail: string, tone: string) => (
    <button
      type="button"
      onClick={() => setChoice(value)}
      aria-pressed={choice === value}
      className={`w-full rounded-lg border-2 p-4 text-left transition-colors ${
        choice === value ? tone : "border-border hover:bg-muted"
      }`}
    >
      <span className="block text-base font-bold">{title}</span>
      <span className="mt-1 block text-sm text-muted-foreground">{detail}</span>
    </button>
  );

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-gradient-to-br from-background to-sky-soft">
      <div className="w-full max-w-md rounded-xl border bg-card p-6 sm:p-8 shadow-lift space-y-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            {question?.companyName || "SavyTime"}
          </p>
          <h1 className="mt-1 text-xl font-bold text-primary">
            {question ? `${question.holidayName}, ${formatEmailDate(question.date)}` : "Holiday"}
          </h1>
          {question && (
            <p className="mt-1 text-sm text-muted-foreground">
              Would you like {vaNames} to work on this holiday?
            </p>
          )}
        </div>

        {!question && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

        {question && answered && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
            <p className="font-bold">
              {answered === "work"
                ? `Thank you. ${vaNames} will work on ${formatEmailDate(question.date)}.`
                : `Thank you. ${vaNames} will take ${formatEmailDate(question.date)} off.`}
            </p>
            <p className="mt-1 text-muted-foreground">
              {answered === "work"
                ? "We have let them know. Hours worked on this day are paid overtime and will be included in your next invoice."
                : "Their work for you resumes on the next working day."}{" "}
              To change your answer, simply reply to our email.
            </p>
          </div>
        )}

        {question && !answered && (
          <>
            <div className="space-y-2.5">
              {option(
                "work",
                "Work on Holiday",
                "My VA works this day. Hours are paid overtime on the next invoice.",
                "border-emerald-600 bg-emerald-500/10",
              )}
              {option(
                "off",
                "Do Not Work",
                "My VA takes the holiday off.",
                "border-slate-600 bg-slate-500/10",
              )}
            </div>
            <button
              type="button"
              onClick={confirm}
              disabled={!choice || busy}
              className="btn-lift w-full rounded-md bg-primary py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Saving…" : choice ? "Confirm my answer" : "Pick an answer above"}
            </button>
          </>
        )}

        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      </div>
    </div>
  );
}
