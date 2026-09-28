import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { firebaseConfigured } from "@/lib/firebase";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const { user, isAdmin, loading } = useAuth();

  if (!firebaseConfigured) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-lg rounded-xl border p-8 bg-card shadow-lift">
          <h1 className="text-2xl font-bold text-primary">SavyTime</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Firebase isn't configured yet. Add the following environment variables to enable the
            app:
          </p>
          <ul className="mt-4 space-y-1 text-xs font-mono bg-secondary rounded-md p-3">
            <li>VITE_FIREBASE_API_KEY</li>
            <li>VITE_FIREBASE_AUTH_DOMAIN</li>
            <li>VITE_FIREBASE_PROJECT_ID</li>
            <li>VITE_FIREBASE_STORAGE_BUCKET</li>
            <li>VITE_FIREBASE_MESSAGING_SENDER_ID</li>
            <li>VITE_FIREBASE_APP_ID</li>
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            Copy these from your Firebase project → Project settings → Your apps → Web app config.
          </p>
        </div>
      </div>
    );
  }

  if (loading) return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" />;
  if (isAdmin) return <Navigate to="/admin" />;
  return <Navigate to="/app/punch" />;
}

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="h-10 w-40 skeleton-shimmer" />
    </div>
  );
}
