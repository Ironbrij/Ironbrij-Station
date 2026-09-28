import { isHolidayAssignedToEmployee } from "./attendance.ts";
import { getEmployeeCompanyIds, normalizeCompanyId } from "./company-context.ts";
import {
  companyEmailBranding,
  findCompanyById,
  findEmployeeCompany,
} from "./email-branding.ts";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "./email-template.ts";
import type { Company, CompanyHoliday, Department, Employee } from "./types.ts";

/**
 * Emails each person the holidays they have just been given, through the same
 * n8n webhook the leave emails use. One email per person, so nobody sees who
 * else was told.
 */

export type HolidayEmailResult =
  { ok: true; sent: number; failed: number } | { ok: false; status: number; error: string };

export interface HolidayEmailPlan {
  employee: Employee;
  holidays: CompanyHoliday[];
}

/** Who gets which of these holidays: active people with an email address. */
export function planHolidayEmails(
  holidays: CompanyHoliday[],
  employees: Employee[],
): HolidayEmailPlan[] {
  const plans: HolidayEmailPlan[] = [];
  for (const employee of employees) {
    if (employee.status !== "active" || !employee.email?.includes("@")) continue;
    // Membership as the rest of the app reads it: no company means the main one.
    const member = { ...employee, companyIds: getEmployeeCompanyIds(employee) };
    const theirs = holidays.filter((holiday) => isHolidayAssignedToEmployee(holiday, member));
    if (theirs.length > 0) plans.push({ employee, holidays: theirs });
  }
  return plans;
}

export function formatHolidayDate(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * The companies whose work a holiday gives this person off, or null when it is
 * every company they work for.
 */
export function closedCompanyIds(holiday: CompanyHoliday, employee: Employee): string[] | null {
  const mine = getEmployeeCompanyIds(employee);
  const closing = holiday.companyIds?.length
    ? holiday.companyIds
    : holiday.targetType === "states" && holiday.stateCompanyIds
      ? holiday.stateCompanyIds
      : null;
  if (!closing) return null;
  const closed = closing.map(normalizeCompanyId).filter((id) => mine.includes(id));
  return closed.length === 0 || closed.length === mine.length ? null : closed;
}

/** The company a person's email is branded as: the one closing, if only one is. */
function brandingFor(
  plan: HolidayEmailPlan,
  companies: Company[],
  departments: Department[],
) {
  const scopes = plan.holidays.map((holiday) => closedCompanyIds(holiday, plan.employee));
  const closing = [...new Set(scopes.flatMap((ids) => ids ?? []))];
  const company =
    !scopes.includes(null) && closing.length === 1
      ? findCompanyById(companies, closing[0])
      : findEmployeeCompany(plan.employee, companies, departments);
  return companyEmailBranding(company, closing[0]);
}

export function buildHolidayEmail(
  plan: HolidayEmailPlan,
  companies: Company[],
  departments: Department[],
  appUrl: string,
) {
  const company = brandingFor(plan, companies, departments);
  const firstName = plan.employee.name?.trim().split(/\s+/)[0] || "there";
  const holidays = [...plan.holidays].sort((a, b) => a.date.localeCompare(b.date));
  const one = holidays.length === 1;
  const name = (holiday: CompanyHoliday) => holiday.name?.trim() || "Company Holiday";
  const subject = one
    ? `Day off: ${name(holidays[0])}, ${formatHolidayDate(holidays[0].date)}`
    : `You have ${holidays.length} days off coming up`;
  const headline = one
    ? `You have a day off on ${formatHolidayDate(holidays[0].date)} for ${name(holidays[0])}.`
    : `You have ${holidays.length} days off coming up.`;
  // Someone working for companies in two states is only off for the closed one.
  const companyName = (id: string) =>
    findCompanyById(companies, id)?.name || (id === "default" ? "the main company" : id);
  const scope = (holiday: CompanyHoliday) => {
    const closed = closedCompanyIds(holiday, plan.employee);
    return closed ? ` (your work for ${closed.map(companyName).join(", ")} only)` : "";
  };
  const partly = holidays.some((holiday) => closedCompanyIds(holiday, plan.employee));
  const lines = holidays.map(
    (holiday) => `${name(holiday)}: ${formatHolidayDate(holiday.date)}${scope(holiday)}`,
  );
  const text = [
    `Hi ${firstName},`,
    "",
    headline,
    "",
    ...lines,
    "",
    `You don't need to punch in on ${one ? "this day" : "these days"}. Work done on a holiday is counted as holiday work, not regular hours.`,
    ...(partly
      ? ["Work for your other companies on the same day is a normal working day."]
      : []),
    "",
    `Open SavyTimes: ${appUrl}`,
  ].join("\n");
  const accentColor = "#7c3aed";
  const html = renderCompanyEmail({
    company,
    preheader: headline,
    label: "Holiday",
    title: one ? "You have a day off" : "Days off coming up",
    introHtml: `Hi ${escapeEmailHtml(firstName)}, ${escapeEmailHtml(headline.charAt(0).toLowerCase() + headline.slice(1))}`,
    contentHtml: `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
        holidays.map((holiday) => ({
          label: name(holiday),
          value: `${formatHolidayDate(holiday.date)}${scope(holiday)}`,
        })),
        accentColor,
      )}</table>
      <p style="margin: 18px 0 0; font-size: 14px; line-height: 21px; color: #4a5568;">You don't need to punch in on ${one ? "this day" : "these days"}.${partly ? " Work for your other companies on the same day is a normal working day." : ""}</p>`,
    cta: { label: "Open SavyTimes", url: appUrl },
    accentColor,
  });
  return { company, subject, text, html };
}

export async function sendHolidayEmails({
  holidays,
  employees,
  companies,
  departments,
  appUrl,
  fetchImpl = fetch,
}: {
  holidays: CompanyHoliday[];
  employees: Employee[];
  companies: Company[];
  departments: Department[];
  appUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<HolidayEmailResult> {
  if (holidays.length === 0) return { ok: false, status: 404, error: "Holiday not found" };
  const plans = planHolidayEmails(holidays, employees);
  // Any n8n workflow that mails email.to works; the report workflow is one.
  const webhookUrl =
    process.env.N8N_HOLIDAY_WEBHOOK_URL ||
    process.env.N8N_LEAVE_TEAM_WEBHOOK_URL ||
    process.env.N8N_REPORT_WEBHOOK_URL ||
    "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";

  let sent = 0;
  let failed = 0;
  // A few at a time, so a big team does not flood the webhook.
  for (let index = 0; index < plans.length; index += 5) {
    await Promise.all(
      plans.slice(index, index + 5).map(async (plan) => {
        const email = buildHolidayEmail(plan, companies, departments, appUrl);
        try {
          const response = await fetchImpl(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event: "holiday_notice",
              company: email.company,
              employeeId: plan.employee.id,
              employeeName: plan.employee.name,
              holidays: plan.holidays.map(({ id, date, name }) => ({ id, date, name })),
              email: {
                to: plan.employee.email.trim(),
                subject: email.subject,
                text: email.text,
                html: email.html,
              },
            }),
          });
          if (response.ok) sent += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }),
    );
  }
  if (plans.length > 0 && sent === 0) {
    return { ok: false, status: 502, error: "The n8n webhook did not accept the holiday emails" };
  }
  return { ok: true, sent, failed };
}
