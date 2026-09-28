import { createFileRoute } from "@tanstack/react-router";
import { listCollection, requireAdmin } from "@/lib/admin-request";
import { normalizeCompanyId } from "@/lib/company-context";
import { formatEmailDate } from "@/lib/email-template";
import { planClientDstEmails, sendClientDstEmails } from "@/lib/dst-email";
import type { Company, Employee } from "@/lib/types";

/**
 * Daylight saving notices for clients. With `dryRun` it lists the clients whose
 * clocks change in the next three weeks, so the admin can see who would be told;
 * without it, it emails the clients named in `companyIds`.
 *
 * Companies and people are read with the admin's own login, never taken from
 * the request, so the endpoint cannot mail anyone else.
 */

export const Route = createFileRoute("/api/dst-notification")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const admin = await requireAdmin(request);
        if ("response" in admin) return admin.response;
        const { idToken } = admin;

        let body: { dryRun?: unknown; companyIds?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        const dryRun = body.dryRun === true;
        const companyIds = Array.isArray(body.companyIds) ? body.companyIds : [];
        if (
          !dryRun &&
          (companyIds.length === 0 ||
            companyIds.length > 200 ||
            !companyIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(id)))
        ) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        let companies: Company[];
        let employees: Employee[];
        try {
          [companies, employees] = await Promise.all([
            listCollection<Company>("companies", idToken),
            listCollection<Employee>("employees", idToken),
          ]);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
        }

        const plans = planClientDstEmails(companies, employees, new Date());
        if (dryRun) {
          return Response.json({
            ok: true,
            clients: plans.map((plan) => ({
              companyId: normalizeCompanyId(plan.company.id),
              companyName: plan.company.name,
              to: plan.to,
              date: plan.change.date,
              dateLabel: formatEmailDate(plan.change.date),
              kind: plan.change.kind,
              timezone: plan.change.timezone,
              vas: plan.schedules.length + plan.unscheduled.length,
            })),
          });
        }

        const wanted = new Set((companyIds as string[]).map(normalizeCompanyId));
        const chosen = plans.filter((plan) => wanted.has(normalizeCompanyId(plan.company.id)));
        const result = await sendClientDstEmails({ plans: chosen });
        if (chosen.length > 0 && result.sent === 0) {
          return Response.json(
            { ok: false, error: "The n8n webhook did not accept the daylight saving emails" },
            { status: 502 },
          );
        }
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
