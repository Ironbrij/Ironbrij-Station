import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2,
  Copy,
  Download,
  MousePointer2,
  Palette,
  RotateCcw,
  Timer,
} from "lucide-react";
import { toast } from "sonner";
import { ClockBallPreview } from "@/components/ClockBall";
import { CLOCK_BALL_DOWNLOAD } from "@/lib/clock-ball";
import { useAuth } from "@/lib/auth-context";
import { connectClockBall, useClockBallExtension } from "@/lib/use-clock-ball";

export const Route = createFileRoute("/_authenticated/app/clock-ball")({
  head: () => ({
    meta: [
      { title: "Clock Ball extension — SavyTime" },
      {
        name: "description",
        content: "Download the Clock Ball Chrome extension to keep your shift time in view.",
      },
    ],
  }),
  component: ClockBallPage,
});

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Download the extension",
    body: (
      <>
        Click <strong>Download extension</strong> above. You get a file called{" "}
        <code>savytime-clock-ball.zip</code>.
      </>
    ),
  },
  {
    title: "Unzip it",
    body: (
      <>
        Right-click the zip and choose <strong>Extract All…</strong> (on a Mac, double-click it).
        Keep the <code>savytime-clock-ball</code> folder somewhere safe, like Documents. Chrome uses
        it from there, so don't delete it.
      </>
    ),
  },
  {
    title: "Open Chrome's extensions page",
    body: (
      <>
        Copy <code>chrome://extensions</code> with the button below, paste it into Chrome's address
        bar and press Enter.
      </>
    ),
  },
  {
    title: "Turn on Developer mode",
    body: (
      <>
        Switch on <strong>Developer mode</strong> in the top-right corner of that page.
      </>
    ),
  },
  {
    title: "Load the folder",
    body: (
      <>
        Click <strong>Load unpacked</strong>. Go to the folder that <em>holds</em>{" "}
        <code>savytime-clock-ball</code>, click <code>savytime-clock-ball</code> once, then click{" "}
        <strong>Select Folder</strong>. Don't open it first: inside, the <code>icons</code> folder
        gets picked by mistake and Chrome says "Manifest file is missing".
      </>
    ),
  },
  {
    title: "Sign in to the extension",
    body: (
      <>
        A sign-in page opens by itself. Use your SavyTime email and password. If you sign in to
        SavyTime with Google, come back to this page and click{" "}
        <strong>Connect the extension</strong> above instead. Then pin it from the puzzle-piece icon
        in the toolbar. If you're already clocked in, the ball pops up straight away.
      </>
    ),
  },
];

const TIPS = [
  {
    icon: Timer,
    text: "Appears when you start work and counts your worked time. Breaks pause it.",
  },
  { icon: MousePointer2, text: "Drag it anywhere on the screen. It stays where you put it." },
  { icon: Palette, text: "Click the extension icon to make it pink, purple, green and more." },
  {
    icon: RotateCcw,
    text: "Linked to your punches: it keeps going if you close SavyTime or reopen Chrome, and vanishes as soon as you stop work, even from your phone, or when your shift ends.",
  },
];

function ClockBallPage() {
  const { employee } = useAuth();
  const extension = useClockBallExtension();

  async function copyExtensionsLink() {
    try {
      await navigator.clipboard.writeText("chrome://extensions");
      toast.success("Copied. Paste it into Chrome's address bar.");
    } catch {
      toast.error("Couldn't copy. Type chrome://extensions into the address bar instead.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pt-4">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-[#0b2a7a] via-[#123a9c] to-[#1d4ed8] p-6 text-white shadow-lift sm:p-8">
        <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:text-left">
          <ClockBallPreview size={112} />
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-white/70">
              New · Chrome extension
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Meet the Clock Ball</h1>
            <p className="text-sm leading-relaxed text-white/85">
              A little robot ball that sits on your screen and shows how long you've worked this
              shift, on every website you open.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
              <a
                href={CLOCK_BALL_DOWNLOAD}
                download
                className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-2.5 text-sm font-semibold text-[#0b2a7a] shadow-xs transition-colors hover:bg-white/90"
              >
                <Download className="h-4 w-4" /> Download extension
              </a>
              {extension && extension.connectedAs && (
                <span className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3 py-2 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4" /> Installed · signed in as{" "}
                  {extension.connectedAs}
                </span>
              )}
              {extension && !extension.connectedAs && employee && (
                // For Google sign-ins: the extension's own form only takes a password.
                <button
                  type="button"
                  onClick={() => connectClockBall(employee)}
                  className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/25"
                >
                  <CheckCircle2 className="h-4 w-4" /> Connect the extension as {employee.name}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border bg-card p-6 shadow-xs sm:p-8">
        <h2 className="text-lg font-semibold">How to install</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Takes about a minute. Works in Google Chrome, Microsoft Edge and Brave.
        </p>
        <ol className="mt-6 space-y-5">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                {index + 1}
              </span>
              <div className="space-y-2 pt-1 text-sm">
                <div className="font-semibold text-foreground">{step.title}</div>
                <p className="leading-relaxed text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-foreground">
                  {step.body}
                </p>
                {index === 2 && (
                  <button
                    type="button"
                    onClick={copyExtensionsLink}
                    className="inline-flex items-center gap-2 rounded-lg border bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground hover:bg-secondary/80"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy chrome://extensions
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        {TIPS.map(({ icon: Icon, text }) => (
          <div key={text} className="flex gap-3 rounded-2xl border bg-card p-4 text-sm shadow-xs">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </div>
            <p className="leading-relaxed text-muted-foreground">{text}</p>
          </div>
        ))}
      </section>

      <p className="pb-6 text-center text-xs text-muted-foreground">
        The ball can't appear on Chrome's own pages (new tab, settings, the extensions page). Open
        any website and it's there.
      </p>
    </div>
  );
}
