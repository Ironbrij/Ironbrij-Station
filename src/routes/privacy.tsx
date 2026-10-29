import { createFileRoute } from "@tanstack/react-router";

/**
 * The privacy policy for the SavyTime Clock Ball browser extension. The Chrome
 * Web Store links to it, so it is public: no sign-in.
 */
export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy — SavyTime extension" },
      {
        name: "description",
        content: "What the SavyTime browser extension stores and why.",
      },
    ],
  }),
  component: PrivacyPage,
});

const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: "Who we are",
    body: [
      "SavyTime is Ironbrij's time-tracking system. The SavyTime browser extension is made by Ironbrij for Ironbrij employees who have a SavyTime account.",
    ],
  },
  {
    title: "What the extension stores",
    body: [
      "Your SavyTime sign-in (so it can read your own punches), your name and email (to show who is signed in), your recent punch times, and your ball settings: size, face, colour, position, hat picture, blinking and jokes.",
      "All of this is kept in your own browser, in the extension's storage. It is not stored anywhere else by the extension.",
    ],
  },
  {
    title: "What it does with it",
    body: [
      "It reads your own punches from SavyTime's database (Google Firebase) to show your shift time and to know when you start, pause and stop work. That is its only use.",
      "It does not sell, share or send your information to anyone else, and does not use it for advertising.",
    ],
  },
  {
    title: "Websites you visit",
    body: [
      "The ball is drawn on top of the web pages you open. The extension does not read, collect or send anything from those pages.",
    ],
  },
  {
    title: "Removing your data",
    body: [
      "Signing out of the extension deletes your sign-in and punch times from it. Removing the extension from your browser deletes everything it stored.",
    ],
  },
  {
    title: "Questions",
    body: ["Ask your Ironbrij administrator, or use Help & Feedback in SavyTime."],
  },
];

function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-12 text-foreground">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">SavyTime extension: privacy</h1>
        <p className="mt-1 text-sm text-muted-foreground">Last updated 26 October 2026</p>
      </div>
      {SECTIONS.map((section) => (
        <section key={section.title} className="space-y-2">
          <h2 className="text-lg font-semibold">{section.title}</h2>
          {section.body.map((text) => (
            <p key={text} className="text-sm leading-relaxed text-muted-foreground">
              {text}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
}
