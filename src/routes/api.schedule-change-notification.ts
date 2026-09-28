import { createFileRoute } from "@tanstack/react-router";
import { listCollection, readDocument, requireAdmin } from "@/lib/admin-request";
import { sendScheduleChangeEmails } from "@/lib/schedule-change-email";
import type { Company, Employee } from "@/lib/types";

/**
 * Emails a VA, and the clients affected, after an admin starts or ends a
 * temporary schedule on their profile. The hours are read from the saved
 * profile with the admin's own login; the request only says which companies
 * moved, by how much, and whether it started or ended.
 */

const ID = /^[A-Za-z0-9_-]{1,150}$/;

export const Route = createFileRoute("/api/schedule-change-notification")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const admin = await requireAdmin(request);
        if ("response" in admin) return admin.response;
        const { idToken } = admin;

        let body: {
          employeeId?: unknown;
          companyIds?: unknown;
          minutes?: unknown;
          started?: unknown;
          emailVa?: unknown;
          emailClients?: unknown;
        };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        const { employeeId, companyIds, minutes, started } = body;
        if (
          typeof employeeId !== "string" ||
          !ID.test(employeeId) ||
          !Array.isArray(companyIds) ||
          companyIds.length === 0 ||
          companyIds.length > 50 ||
          !companyIds.every((id) => typeof id === "string" && ID.test(id)) ||
          typeof minutes !== "number" ||
          !Number.isInteger(minutes) ||
          Math.abs(minutes) > 180 ||
          typeof started !== "boolean"
        ) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        let employee: Employee | null;
        let companies: Company[];
        try {
          [employee, companies] = await Promise.all([
            readDocument<Employee>(`employees/${employeeId}`, idToken),
            listCollection<Company>("companies", idToken),
          ]);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
        }
        if (!employee)
          return Response.json({ ok: false, error: "Employee not found" }, { status: 404 });

        const result = await sendScheduleChangeEmails({
          employee: { ...employee, id: employeeId },
          companies,
          companyIds: companyIds as string[],
          minutes,
          started,
          emailVa: body.emailVa !== false,
          emailClients: body.emailClients !== false,
        });
        return Response.json({ ok: true, ...result });
      },
    },
  },
});
