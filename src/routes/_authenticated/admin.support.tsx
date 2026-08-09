import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/admin/support")({
  head: () => ({
    meta: [
      { title: "Support — SavyTimes Admin" },
      { name: "description", content: "Help and FAQ." },
      { property: "og:title", content: "Support — SavyTimes Admin" },
      { property: "og:description", content: "Help and FAQ." },
    ],
  }),
  component: SupportPage,
});

function SupportPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-primary">Support</h1>
      <div className="mt-6 rounded-xl border bg-card p-6 space-y-4">
        <FAQ
          q="How do I add an employee?"
          a="Go to Employees → New Employee. An invite email will be sent."
        />
        <FAQ
          q="What happens if an employee doesn't punch out?"
          a="v1 does not auto-punch out — the running timer continues until they punch out manually. Auto punch-out is planned for a later release."
        />
        <FAQ
          q="How do holidays work?"
          a="Set them under Company. On a holiday, employees see a celebration screen and cannot punch."
        />
        <FAQ
          q="How do approved leaves affect punching?"
          a="A full-day leave blocks the whole date. Half-day leave blocks only the selected half of the employee's shift, and a scheduled break blocks only its approved start-to-end time."
        />
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        Need more help? Contact your workspace administrator.
      </p>
    </div>
  );
}

function FAQ({ q, a }: { q: string; a: string }) {
  return (
    <div>
      <div className="font-medium">{q}</div>
      <div className="text-sm text-muted-foreground mt-1">{a}</div>
    </div>
  );
}
