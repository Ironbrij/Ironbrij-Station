import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { doc, getDoc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { auth, db, firebaseConfigured } from "@/lib/firebase";
import { toast } from "sonner";

export const Route = createFileRoute("/invite/$token")({
  head: () => ({
    meta: [
      { title: "Accept Invite — SavyTimes" },
      { name: "description", content: "Set up your SavyTimes account." },
      { property: "og:title", content: "Accept Invite — SavyTimes" },
      { property: "og:description", content: "Set up your SavyTimes account." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AcceptInvite,
});

function AcceptInvite() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ email: string; employeeId: string; used: boolean } | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!firebaseConfigured) {
      setError("Firebase not configured");
      setLoading(false);
      return;
    }

    let resolved = false;

    // Safety timeout: If Firestore takes more than 3.5 seconds, unblock UI
    const timer = setTimeout(() => {
      if (!resolved) {
        setError("Loading took too long. Please check your network connection or click reload.");
        setLoading(false);
      }
    }, 3500);

    const unsub = onSnapshot(
      doc(db(), "invites", token),
      (snap) => {
        resolved = true;
        clearTimeout(timer);
        if (!snap.exists()) {
          setError("Invalid invite link");
          setLoading(false);
          return;
        }
        const data = snap.data() as { email: string; employeeId: string; used: boolean };
        if (data.used) {
          setError("This invite has already been used");
          setLoading(false);
          return;
        }
        setInvite(data);
        setError(null);
        setLoading(false);
      },
      (err) => {
        resolved = true;
        clearTimeout(timer);
        setError("Database connection error: " + err.message);
        setLoading(false);
      },
    );

    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [token]);

  async function handleGoogleActivate() {
    if (!invite) return;
    setGoogleBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      const cred = await signInWithPopup(auth(), provider);

      // Verify email address matches the invite email
      const userEmail = cred.user.email?.toLowerCase().trim() ?? "";
      const inviteEmail = invite.email.toLowerCase().trim();

      if (userEmail !== inviteEmail) {
        toast.error(
          `This invite was issued for ${invite.email}. You signed in with ${cred.user.email || "a different email"}.`,
        );
        setGoogleBusy(false);
        return;
      }

      const empSnap = await getDoc(doc(db(), "employees", invite.employeeId));
      const empData = empSnap.exists() ? empSnap.data() : {};

      // Save employee record and update invite token simultaneously (client only writes to its own authUid)
      await Promise.all([
        setDoc(doc(db(), "employees", cred.user.uid), {
          ...empData,
          authUid: cred.user.uid,
          inviteStatus: "accepted",
        }),
        updateDoc(doc(db(), "invites", token), { used: true }),
      ]);

      toast.success("Account activated with Google!");
      navigate({ to: "/" });
    } catch (err: unknown) {
      const message = (err as Error)?.message || "Google activation failed";
      if (!message.includes("auth/popup-closed-by-user")) {
        toast.error(message);
      }
    } finally {
      setGoogleBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!invite) return;
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth(), invite.email, password);
      const empSnap = await getDoc(doc(db(), "employees", invite.employeeId));
      const empData = empSnap.exists() ? empSnap.data() : {};

      // Save employee record and update invite token simultaneously
      await Promise.all([
        setDoc(doc(db(), "employees", cred.user.uid), {
          ...empData,
          authUid: cred.user.uid,
          inviteStatus: "accepted",
        }),
        updateDoc(doc(db(), "invites", token), { used: true }),
      ]);

      toast.success("Account created!");
      navigate({ to: "/" });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading)
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="h-8 w-40 skeleton-shimmer" />
        <button
          onClick={() => window.location.reload()}
          className="text-xs text-muted-foreground hover:underline"
        >
          Taking too long? Click here to reload
        </button>
      </div>
    );
  if (error)
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-sm rounded-xl border bg-card p-6 text-center shadow-lift">
          <h1 className="text-lg font-semibold text-primary">Invite unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="btn-lift mt-4 bg-primary text-primary-foreground text-xs font-semibold px-4 py-2 rounded-md"
          >
            Reload / Retry
          </button>
        </div>
      </div>
    );

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-lift">
        <h1 className="text-2xl font-bold text-primary">Welcome!</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Activate your account for <strong>{invite?.email}</strong>.
        </p>

        <button
          type="button"
          disabled={busy || googleBusy}
          onClick={handleGoogleActivate}
          className="btn-lift mt-6 flex w-full items-center justify-center gap-3 rounded-md border border-input bg-background py-2.5 px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          {googleBusy ? "Activating..." : "Activate with Google"}
        </button>

        <div className="relative my-6 flex items-center justify-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <span className="relative bg-card px-3 text-xs uppercase text-muted-foreground">
            Or set a password
          </span>
        </div>

        <form onSubmit={submit}>
          <label className="block text-sm font-medium">Password</label>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            disabled={busy || googleBusy}
            className="btn-lift mt-6 w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground"
          >
            {busy ? "Creating…" : "Activate account"}
          </button>
        </form>
      </div>
    </div>
  );
}
