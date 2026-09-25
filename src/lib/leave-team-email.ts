import {
  companyEmailBranding,
  findEmployeeCompany,
  type CompanyEmailBranding,
} from "./email-branding.ts";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "./email-template.ts";
import { fromFirestoreFields, type FirestoreValue } from "./firestore-rest.ts";
import {
  buildLeaveTeamNoticeText,
  describeLeaveDates,
  findLeaveEmployee,
  resolveLeaveNoticeRecipients,
  type LeaveTeamNoticeEvent,
} from "./leave-team-notice.ts";
import type { Company, Department, Employee, LeaveRequest } from "./types.ts";

/**
 * Sends the team email about a colleague's leave. The admin screen's endpoint
 * and the MCP tools both come through here, so an approval tells the team
 * whichever way it was made.
 */

export type LeaveTeamNoticeResult =
  { ok: true; sent: number } | { ok: false; status: number; error: string };

export async function sendLeaveTeamNotice({
  event,
  leaveRequestId,
  leave,
  employees,
  departments,
  company,
  appUrl,
  fetchImpl = fetch,
}: {
  event: LeaveTeamNoticeEvent;
  leaveRequestId: string;
  leave: LeaveRequest;
  employees: Employee[];
  departments: Department[];
  company: CompanyEmailBranding;
  appUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<LeaveTeamNoticeResult> {
  // The team hears about leave only once an admin has approved it.
  const expectedStatus = event === "approved" ? "approved" : "rejected";
  if (leave.status !== expectedStatus) {
    return { ok: false, status: 409, error: `Leave is ${leave.status}, not ${expectedStatus}` };
  }

  const employee = findLeaveEmployee(leave, employees);
  if (!employee) return { ok: false, status: 404, error: "Employee not found" };
  const recipients = resolveLeaveNoticeRecipients(employee, departments, employees);
  if (recipients.length === 0) return { ok: true, sent: 0 };

  const companyName = company.name?.trim() || "SavyTimes";
  const teamName = departments.find((item) => item.id === employee.deptId)?.name;
  const notice = buildLeaveTeamNoticeText({
    event,
    employeeName: employee.name,
    teamName,
    companyName,
    leave,
  });
  const accentColor = event === "approved" ? "#7c3aed" : "#475569";
  const when = describeLeaveDates(leave);
  const html = renderCompanyEmail({
    company,
    preheader: notice.headline,
    label: event === "approved" ? "Team leave" : "Leave update",
    title: event === "approved" ? "A teammate will be away" : "Leave cancelled",
    introHtml: escapeEmailHtml(notice.headline),
    contentHtml: `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
        [
          { label: "Who", value: employee.name },
          ...(teamName ? [{ label: "Team", value: teamName }] : []),
          {
            label: "When",
            value: when.charAt(0).toUpperCase() + when.slice(1),
          },
          ...(event === "revoked" ? [{ label: "Status", value: "Working as usual" }] : []),
        ],
        accentColor,
      )}</table>`,
    cta: { label: "Open SavyTimes", url: appUrl },
    accentColor,
  });

  // Any n8n workflow that mails email.to works; the report workflow is one.
  const webhookUrl =
    process.env.N8N_LEAVE_TEAM_WEBHOOK_URL ||
    process.env.N8N_REPORT_WEBHOOK_URL ||
    "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: event === "approved" ? "leave_team_notice" : "leave_team_revoked",
      company,
      leaveRequestId,
      employeeId: employee.id,
      employeeName: employee.name,
      team: teamName,
      email: {
        to: recipients.join(","),
        subject: notice.subject,
        text: notice.text,
        html,
      },
    }),
  });
  if (!response.ok) {
    return { ok: false, status: 502, error: `n8n webhook returned ${response.status}` };
  }
  return { ok: true, sent: recipients.length };
}

async function listDocuments<T>(
  baseUrl: string,
  collection: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  for (let page = 0; page < 40; page += 1) {
    const url = new URL(`${baseUrl}/${collection}`);
    url.searchParams.set("pageSize", "300");
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url.toString());
    if (!response.ok) throw new Error(`Could not read ${collection}: ${response.status}`);
    const data = (await response.json()) as {
      documents?: { name: string; fields?: Record<string, FirestoreValue> }[];
      nextPageToken?: string;
    };
    for (const document of data.documents || []) {
      out.push({ ...fromFirestoreFields(document.fields), id: document.name.split("/").pop() });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

/**
 * For the MCP tools, which reach Firestore with the server's key rather than an
 * admin's login: reads the people, teams and company, then sends. Never throws,
 * so a failed email never undoes the decision.
 */
export async function sendLeaveTeamNoticeWithKey({
  baseUrl,
  apiKey,
  event,
  leaveRequestId,
  leave,
  appUrl,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  apiKey: string;
  event: LeaveTeamNoticeEvent;
  leaveRequestId: string;
  leave: LeaveRequest;
  appUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<LeaveTeamNoticeResult> {
  try {
    const [employees, departments, companies] = await Promise.all([
      listDocuments<Employee>(baseUrl, "employees", apiKey, fetchImpl),
      listDocuments<Department>(baseUrl, "departments", apiKey, fetchImpl),
      listDocuments<Company>(baseUrl, "companies", apiKey, fetchImpl),
    ]);
    const employee = findLeaveEmployee(leave, employees);
    const company = companyEmailBranding(
      employee ? findEmployeeCompany(employee, companies, departments) : undefined,
      employee?.companyId,
    );
    return await sendLeaveTeamNotice({
      event,
      leaveRequestId,
      leave,
      employees,
      departments,
      company,
      appUrl,
      fetchImpl,
    });
  } catch (error) {
    return { ok: false, status: 502, error: (error as Error).message };
  }
}

/** One line for an MCP reply saying whether the team was told. */
export function describeLeaveTeamNoticeResult(result: LeaveTeamNoticeResult): string {
  if (!result.ok) return `The team leave email could not be sent (${result.error}).`;
  if (result.sent === 0) return "No team is set to be emailed for this department.";
  return `Team notified (${result.sent} ${result.sent === 1 ? "person" : "people"}).`;
}
