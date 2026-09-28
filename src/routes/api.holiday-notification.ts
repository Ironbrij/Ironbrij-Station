import { createFileRoute } from "@tanstack/react-router";
import { resolveAppUrl } from "@/lib/app-url";
import { createDocument, listCollection, readDocument, requireAdmin } from "@/lib/admin-request";
import { newHolidayResponse, newResponseToken } from "@/lib/holiday-response";
import { sendHolidayEmails } from "@/lib/holiday-email";
import { sharedCalendar } from "@/lib/holidays";
import {
  COMPANY_ID,
  type Company,
  type CompanyHoliday,
  type Department,
  type Employee,
} from "@/lib/types";

/**
 * Emails everyone who was just given a holiday. Called by the admin screen
 * right after holidays are added.
 *
 * The holidays and the people are read from Firestore with the admin's own
 * login, never taken from the request, so the endpoint cannot mail anyone else.
 */

export const Route = createFileRoute("/api/holiday-notification")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const admin = await requireAdmin(request);
        if ("response" in admin) return admin.response;
        const { idToken, email: adminEmail } = admin;

        let body: { holidayIds?: unknown };
        try {
          body = (await request.json()) as { holidayIds?: unknown };
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        const holidayIds = Array.isArray(body.holidayIds) ? body.holidayIds : [];
        if (
          holidayIds.length === 0 ||
          holidayIds.length > 60 ||
          !holidayIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(id))
        ) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        let calendar: Company | null;
        let companies: Company[];
        let employees: Employee[];
        let departments: Department[];
        try {
          [calendar, companies, employees, departments] = await Promise.all([
            readDocument<Company>(`companies/${COMPANY_ID}`, idToken),
            listCollection<Company>("companies", idToken),
            listCollection<Employee>("employees", idToken),
            listCollection<Department>("departments", idToken),
          ]);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
        }

        // State holidays name the companies in their states, as on every screen.
        calendar = calendar ? sharedCalendar(companies, calendar) : null;
        const wanted = new Set(holidayIds as string[]);
        const holidays: CompanyHoliday[] = [
          ...(calendar?.holidays ?? []).map((date) => ({
            id: `legacy-${date}`,
            date,
            name: "Company Holiday",
            targetType: "all" as const,
          })),
          ...(calendar?.holidayAssignments ?? []),
        ].filter((holiday) => wanted.has(holiday.id));

        const result = await sendHolidayEmails({
          holidays,
          employees,
          companies,
          departments,
          appUrl: resolveAppUrl(request.url),
          // Each client's Work on Holiday / Do Not Work answer is saved under its own token.
          saveClientQuestion: async (company, holiday, vas) => {
            const token = newResponseToken();
            const record = newHolidayResponse({ company, holiday, vas, notifyEmail: adminEmail });
            await createDocument("holidayResponses", token, { ...record }, idToken);
            return token;
          },
        });
        if (!result.ok) {
          return Response.json({ ok: false, error: result.error }, { status: result.status });
        }
        return Response.json({
          ok: true,
          sent: result.sent,
          failed: result.failed,
          clients: result.clients,
        });
      },
    },
  },
});
