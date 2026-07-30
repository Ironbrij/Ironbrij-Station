import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDocs, onSnapshot, query, where, writeBatch } from "firebase/firestore";
import { Copy, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import type { PersonalAutomationProfile } from "@/lib/personal-automation";
import type { Punch } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/app/automation")({
  head: () => ({
    meta: [
      { title: "Automation API — Time Station" },
      {
        name: "description",
        content: "Create a private attendance status URL for personal automations.",
      },
    ],
  }),
  component: AutomationPage,
});

function generatePrivateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function AutomationPage() {
  const { user, employee } = useAuth();
  const [profile, setProfile] = useState<PersonalAutomationProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }

    const profileQuery = query(
      collection(db(), "automationProfiles"),
      where("ownerUid", "==", user.uid),
    );
    return onSnapshot(
      profileQuery,
      (snapshot) => {
        const current = snapshot.docs[0];
        setProfile(
          current
            ? {
                id: current.id,
                ...(current.data() as Omit<PersonalAutomationProfile, "id">),
              }
            : null,
        );
        setLoading(false);
      },
      (error) => {
        console.error("Personal API profile could not be loaded:", error);
        setLoading(false);
      },
    );
  }, [user]);

  const personalUrl = useMemo(
    () =>
      profile && origin
        ? `${origin}/api/automation-status?token=${encodeURIComponent(profile.id)}`
        : "",
    [origin, profile],
  );

  async function createPersonalApi(replaceExisting = false) {
    if (!user || !employee) return;
    if (
      replaceExisting &&
      !window.confirm("Regenerate this URL? The current URL will stop working immediately.")
    ) {
      return;
    }

    setBusy(true);
    try {
      const [existingProfiles, punchesSnapshot] = await Promise.all([
        getDocs(query(collection(db(), "automationProfiles"), where("ownerUid", "==", user.uid))),
        getDocs(query(collection(db(), "punches"), where("employeeId", "==", employee.id))),
      ]);
      const punches = punchesSnapshot.docs
        .map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) }))
        .sort((a, b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0));
      const latestPunch = punches[punches.length - 1];
      const isPunchedIn = latestPunch?.type === "in" || latestPunch?.type === "extra_in";
      const now = new Date().toISOString();
      const token = generatePrivateToken();
      const batch = writeBatch(db());

      existingProfiles.docs.forEach((existing) => batch.delete(existing.ref));
      batch.set(doc(db(), "automationProfiles", token), {
        ownerUid: user.uid,
        employeeId: employee.id,
        employeeName: employee.name,
        enabled: true,
        status: isPunchedIn ? "punched_in" : "punched_out",
        isPunchedIn,
        event: "snapshot",
        eventId: latestPunch ? `snapshot:${latestPunch.id}` : `snapshot:${token.slice(0, 16)}`,
        punchId: latestPunch?.id || "",
        punchType: latestPunch?.type || "",
        date: latestPunch?.date || "",
        occurredAt: latestPunch?.timestamp?.toDate().toISOString() || now,
        createdAt: now,
        updatedAt: now,
      });
      await batch.commit();
      toast.success(replaceExisting ? "Personal API URL regenerated" : "Personal API URL created");
    } catch (error) {
      toast.error("Could not create personal API: " + (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!personalUrl) return;
    await navigator.clipboard.writeText(personalUrl);
    toast.success("Personal API URL copied");
  }

  async function revokeUrl() {
    if (!profile || !window.confirm("Revoke this URL? Any workflow using it will stop working.")) {
      return;
    }

    setBusy(true);
    try {
      const batch = writeBatch(db());
      batch.delete(doc(db(), "automationProfiles", profile.id));
      await batch.commit();
      toast.success("Personal API URL revoked");
    } catch (error) {
      toast.error("Could not revoke personal API: " + (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!employee) {
    return (
      <div className="py-12 text-center text-sm">Your employee profile is not active yet.</div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Personal automation API</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a private URL that reports your latest punch status to n8n or another workflow.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">Your private status URL</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Treat this URL like a password. Anyone with it can read your punch status.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="mt-5 text-sm text-muted-foreground">Loading…</p>
        ) : profile ? (
          <div className="mt-5 space-y-4">
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">Current API status</div>
              <div className="mt-1 font-medium">
                {profile.isPunchedIn ? "Punched in" : "Punched out"}
              </div>
            </div>

            <input
              readOnly
              aria-label="Personal automation API URL"
              value={personalUrl}
              className="w-full rounded-lg border bg-background px-3 py-2.5 font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyUrl}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                <Copy className="h-4 w-4" /> Copy URL
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => createPersonalApi(true)}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" /> Regenerate
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={revokeUrl}
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" /> Revoke
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => createPersonalApi(false)}
            className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create personal API URL"}
          </button>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5 text-sm sm:p-6">
        <h2 className="font-semibold">Use it in n8n</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>Add a Schedule Trigger, such as once every minute.</li>
          <li>Add an HTTP Request using GET and paste your private URL.</li>
          <li>
            Continue only when <code>attendance.eventId</code> changes, then check whether{" "}
            <code>attendance.event</code> is <code>punch_in</code> or <code>punch_out</code>.
          </li>
        </ol>
      </section>
    </div>
  );
}
