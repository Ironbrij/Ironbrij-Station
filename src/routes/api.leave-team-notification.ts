import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { resolveAppUrl } from "@/lib/app-url";
import { sendLeaveTeamNotice } from "@/lib/leave-team-email";
import type { LeaveTeamNoticeEvent } from "@/lib/leave-team-notice";
import { listCollection, readDocument, requireAdmin } from "@/lib/admin-request";
import type { Department, Employee, LeaveRequest } from "@/lib/types";

/**
 * Tells the teams a department has chosen (for example the Creative Team) that
 * a colleague will be away. Called by the admin screen right after a leave is
 * approved, or after an approved leave is revoked.
 *
 * Recipients and dates are read from Firestore here with the admin's own login,
 * never taken from the request, so the endpoint cannot be used to mail anyone else.
 */

type LeaveTeamNotificationInput = {
  company?: CompanyEmailBranding;
  leaveRequestId: string;
  event: LeaveTeamNoticeEvent;
};

export const Route = createFileRoute("/api/leave-team-notification")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const admin = await requireAdmin(request);
        if ("response" in admin) return admin.response;
        const { idToken } = admin;

        let body: LeaveTeamNotificationInput;
        try {
          body = (await request.json()) as LeaveTeamNotificationInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        if (
          typeof body.leaveRequestId !== "string" ||
          !/^[A-Za-z0-9_-]{1,150}$/.test(body.leaveRequestId) ||
          (body.event !== "approved" && body.event !== "revoked")
        ) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        let leave: LeaveRequest | null;
        let employees: Employee[];
        let departments: Department[];
        try {
          [leave, employees, departments] = await Promise.all([
            readDocument<LeaveRequest>(`leaveRequests/${body.leaveRequestId}`, idToken),
            listCollection<Employee>("employees", idToken),
            listCollection<Department>("departments", idToken),
          ]);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
        }
        if (!leave) {
          return Response.json({ ok: false, error: "Leave request not found" }, { status: 404 });
        }

        const result = await sendLeaveTeamNotice({
          event: body.event,
          leaveRequestId: body.leaveRequestId,
          leave,
          employees,
          departments,
          company: body.company || { name: "SavyTimes" },
          appUrl: resolveAppUrl(request.url),
        });
        if (!result.ok) {
          return Response.json({ ok: false, error: result.error }, { status: result.status });
        }
        return Response.json({ ok: true, sent: result.sent });
      },
    },
  },
});
