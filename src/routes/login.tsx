import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider } from "firebase/auth";
import { auth, firebaseConfigured } from "@/lib/firebase";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — SavyTimes" },
      { name: "description", content: "Sign in to your SavyTimes account." },
      { property: "og:title", content: "Sign in — SavyTimes" },
      { property: "og:description", content: "Sign in to your SavyTimes account." },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  async function handleGoogleSignIn() {
    if (!firebaseConfigured) {
      toast.error("Firebase not configured");
      return;
    }
    setGoogleBusy(true);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth(), provider);
      toast.success("Signed in with Google");
      navigate({ to: "/" });
    } catch (err: unknown) {
      const message = (err as Error)?.message || "Google sign in failed";
      if (!message.includes("auth/popup-closed-by-user")) {
        toast.error(message);
      }
    } finally {
      setGoogleBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!firebaseConfigured) {
      toast.error("Firebase not configured");
      return;
    }
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth(), email, password);
      toast.success("Welcome back");
      navigate({ to: "/" });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-br from-background to-sky-soft">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-lift">
        <h1 className="text-2xl font-bold text-primary">SavyTimes</h1>
        <p className="text-sm text-muted-foreground mt-1">Sign in to continue</p>

        <button
          type="button"
          disabled={busy || googleBusy}
          onClick={handleGoogleSignIn}
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
          {googleBusy ? "Connecting…" : "Continue with Google"}
        </button>

        <div className="relative my-6 flex items-center justify-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <span className="relative bg-card px-3 text-xs uppercase text-muted-foreground">
            Or continue with email
          </span>
        </div>

        <form onSubmit={submit}>
          <label className="block text-sm font-medium">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
          />

          <label className="block mt-4 text-sm font-medium">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
          />

          <button
            disabled={busy || googleBusy}
            className="btn-lift mt-6 w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-xs text-muted-foreground text-center">
          Received an invite?{" "}
          <Link to="/" className="text-primary underline">
            Open the link from your email
          </Link>
        </p>
      </div>
    </div>
  );
}
