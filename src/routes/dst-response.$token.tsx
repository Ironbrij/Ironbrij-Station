import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db, firebaseConfigured } from "@/lib/firebase";
import { formatEmailDate } from "@/lib/email-template";
import type { DstDecision, DstResponse } from "@/lib/dst-response";

/**
 * Where a client's daylight saving notice sends them. The button they pressed
 * is picked already, but nothing is saved until they confirm: mail scanners
 * open links on their own and must never choose for the client.
 */

export const Route = createFileRoute("/dst-response/$token")({
  validateSearch: (search: Record<string, unknown>): { choice?: DstDecision } =>
    search.choice === "follow" || search.choice === "keep" ? { choice: search.choice } : {},
  head: () => ({
    meta: [
      { title: "Daylight saving schedule — SavyTime" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DstAnswer,
});

function DstAnswer() {
  const { token } = Route.useParams();
  const { choice: fromEmail } = Route.useSearch();
  const [question, setQuestion] = useState<DstResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<DstDecision | undefined>(fromEmail);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<DstDecision | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!firebaseConfigured) {
      setError("This page is not available right now.");
      return;
    }
    getDoc(doc(db(), "dstResponses", token))
      .then((snapshot) => {
        if (!snapshot.exists())
          setError("This link is not valid. Please reply to our email instead.");
        else setQuestion(snapshot.data() as DstResponse);
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
      const response = await fetch("/api/dst-response", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, decision: choice }),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok)
        setError(result.error || "Your choice could not be saved. Please try again.");
      else setDone(choice);
    } catch {
      setError("Your choice could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const answered = done ?? question?.decision ?? null;
  const date = question ? formatEmailDate(question.change.date) : "";
  const keep = question?.keepLabel || "Keep their current schedule";
  const minutes = question?.change.minutes ?? 60;
  const amount = minutes === 60 ? "1 hour" : `${minutes} minutes`;
  const option = (value: DstDecision, title: string, detail: string) => (
    <button
      type="button"
      onClick={() => setChoice(value)}
      aria-pressed={choice === value}
      className={`w-full rounded-lg border-2 p-4 text-left transition-colors ${
        choice === value ? "border-cyan-700 bg-cyan-500/10" : "border-border hover:bg-muted"
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
            {question
              ? `Daylight Saving Time ${question.change.kind === "start" ? "starts" : "ends"}, ${date}`
              : "Daylight saving"}
          </h1>
          {question && (
            <p className="mt-1 text-sm text-muted-foreground">
              Which schedule would you like your VA to follow from {date}?
            </p>
          )}
        </div>

        {!question && !error && <p className="text-sm text-muted-foreground">Loading…</p>}

        {question && answered && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm">
            <p className="font-bold">
              Thank you. You chose: {answered === "follow" ? "Follow my new DST schedule" : keep}.
            </p>
            <p className="mt-1 text-muted-foreground">
              We have let your VA know their hours from {date}. To change your choice, simply reply
              to our email.
            </p>
          </div>
        )}

        {question && !answered && (
          <>
            <div className="space-y-2.5">
              {option(
                "follow",
                "Follow my new DST schedule",
                `Same hours on your clock; your VA's own start time moves by ${amount}.`,
              )}
              {option(
                "keep",
                keep,
                `Same hours on your VA's clock; their hours on your clock move by ${amount}.`,
              )}
            </div>
            <button
              type="button"
              onClick={confirm}
              disabled={!choice || busy}
              className="btn-lift w-full rounded-md bg-primary py-2.5 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Saving…" : choice ? "Confirm my choice" : "Pick a schedule above"}
            </button>
          </>
        )}

        {error && <p className="text-sm font-medium text-destructive">{error}</p>}
      </div>
    </div>
  );
}
