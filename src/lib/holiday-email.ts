import { isHolidayAssignedToEmployee } from "./attendance.ts";
import { clientEmailsFor } from "./client-emails.ts";
import { getEmployeeCompanyIds, normalizeCompanyId } from "./company-context.ts";
import { companyEmailBranding, findCompanyById, findEmployeeCompany } from "./email-branding.ts";
import {
  escapeEmailHtml,
  formatEmailDate,
  renderCompanyEmail,
  renderEmailDetails,
} from "./email-template.ts";
import { companyState, regionLabel } from "./holidays.ts";
import { holidayResponseUrl } from "./holiday-response.ts";
import type { Company, CompanyHoliday, Department, Employee } from "./types.ts";

/**
 * Emails each person the holidays they have just been given, through the same
 * n8n webhook the leave emails use. One email per person, so nobody sees who
 * else was told.
 */

export type HolidayEmailResult =
  | { ok: true; sent: number; failed: number; clients: number }
  | { ok: false; status: number; error: string };

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

/** "Monday, 5 October 2026". */
export const formatHolidayDate = formatEmailDate;

const AU_STATE_NAMES: Record<string, string> = {
  ACT: "the Australian Capital Territory",
  NSW: "New South Wales",
  NT: "the Northern Territory",
  QLD: "Queensland",
  SA: "South Australia",
  TAS: "Tasmania",
  VIC: "Victoria",
  WA: "Western Australia",
};

/** "New South Wales", "Auckland", or "" when the company has no state set. */
function stateName(company: Company): string {
  const code = companyState(company);
  return code ? (AU_STATE_NAMES[code] ?? regionLabel(code)) : "";
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
function brandingFor(plan: HolidayEmailPlan, companies: Company[], departments: Department[]) {
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
  /** Whether their client is being asked if they should work, so a decision will follow. */
  clientAsked = false,
) {
  const company = brandingFor(plan, companies, departments);
  const firstName = plan.employee.name?.trim().split(/\s+/)[0] || "there";
  const holidays = [...plan.holidays].sort((a, b) => a.date.localeCompare(b.date));
  const one = holidays.length === 1;
  const name = (holiday: CompanyHoliday) => holiday.name?.trim() || "Company Holiday";
  const subject = one
    ? `Upcoming public holiday: ${name(holidays[0])}, ${formatHolidayDate(holidays[0].date)}`
    : `You have ${holidays.length} upcoming public holidays`;
  const title = one ? "You Have an Upcoming Public Holiday" : "You Have Upcoming Public Holidays";
  const headline = one
    ? `You have an upcoming public holiday on ${formatHolidayDate(holidays[0].date)} for ${name(holidays[0])}.`
    : `You have ${holidays.length} upcoming public holidays.`;
  // Someone working for companies in two states is only off for the closed one.
  const companyName = (id: string) =>
    findCompanyById(companies, id)?.name || (id === "default" ? "the main company" : id);
  const scope = (holiday: CompanyHoliday) => {
    const closed = closedCompanyIds(holiday, plan.employee);
    return closed ? ` (your work for ${closed.map(companyName).join(", ")} only)` : "";
  };
  const partly = holidays.some((holiday) => closedCompanyIds(holiday, plan.employee));
  const details = holidays.map((holiday) => ({
    label: "Upcoming Public Holiday",
    value: `${name(holiday)}, ${formatHolidayDate(holiday.date)}${scope(holiday)}`,
  }));
  const it = one ? "this holiday" : "these holidays";
  const paragraphs = [
    ...(clientAsked
      ? [
          `This is a reminder about your upcoming public ${one ? "holiday" : "holidays"}. Your client will let us know if they would like you to work on ${it}. The system or Accounts Team will notify you once their decision is confirmed.`,
          "If your client requests you to work, please log in and work your usual hours. If they do not request you to work, please do not punch in.",
        ]
      : [
          `This is a reminder about your upcoming public ${one ? "holiday" : "holidays"}. Please do not punch in on ${one ? "this day" : "these days"}.`,
        ]),
    ...(partly ? ["Work for your other companies on the same day is a normal working day."] : []),
  ];
  const text = [
    title,
    "",
    `Hi ${firstName},`,
    "",
    headline,
    "",
    ...details.map((detail) => `${detail.label}: ${detail.value}`),
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const accentColor = "#7c3aed";
  const paragraph = (value: string) =>
    `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${escapeEmailHtml(value)}</p>`;
  const html = renderCompanyEmail({
    company,
    preheader: headline,
    label: "Upcoming Public Holiday",
    title,
    introHtml: `Hi ${escapeEmailHtml(firstName)},<br>${escapeEmailHtml(headline)}`,
    contentHtml: [
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px;">${renderEmailDetails(details, accentColor)}</table>`,
      ...paragraphs.map(paragraph),
      `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`,
    ].join(""),
    accentColor,
  });
  return { company, subject, text, html };
}

export interface ClientHolidayPlan {
  company: Company;
  to: string[];
  /** Each holiday that closes this client, with the people it gives the holiday. */
  days: {
    holiday: CompanyHoliday;
    people: string[];
    vas: { id: string; name: string; email: string }[];
  }[];
}

/**
 * Which clients to tell: every company whose client email wants holidays, with
 * the holidays its people have off from their work there.
 */
export function planClientHolidayEmails(
  holidays: CompanyHoliday[],
  employees: Employee[],
  companies: Company[],
): ClientHolidayPlan[] {
  const plans: ClientHolidayPlan[] = [];
  for (const company of companies) {
    if (company.archived || company.status === "archived") continue;
    const to = clientEmailsFor(company, "holidays");
    if (to.length === 0) continue;
    const id = normalizeCompanyId(company.id);
    const staff = employees.filter(
      (employee) => employee.status === "active" && getEmployeeCompanyIds(employee).includes(id),
    );
    const days = holidays
      .map((holiday) => {
        const vas = staff
          .filter((employee) =>
            isHolidayAssignedToEmployee(
              holiday,
              { ...employee, companyIds: getEmployeeCompanyIds(employee) },
              company,
            ),
          )
          .map((employee) => ({
            id: employee.id,
            name: employee.name?.trim() || employee.email,
            email: employee.email?.trim() || "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { holiday, vas, people: vas.map((va) => va.name) };
      })
      .filter((day) => day.people.length > 0)
      .sort((a, b) => a.holiday.date.localeCompare(b.holiday.date));
    if (days.length > 0) plans.push({ company, to, days });
  }
  return plans;
}

/**
 * One holiday, asked of one client: their Virtual Assistant is off unless they
 * want them to work, and any hours worked are billed as overtime.
 */
export function buildClientHolidayEmail(
  company: Company,
  holiday: CompanyHoliday,
  /** The client's answer link, when one was saved; without it they reply instead. */
  answer?: { appUrl: string; token: string },
) {
  const branding = companyEmailBranding(company, company.id);
  const clientName = company.name?.trim() || "there";
  const holidayName = holiday.name?.trim() || "the public holiday";
  const date = formatHolidayDate(holiday.date);
  const state = stateName(company);
  const where = state ? ` in ${state},` : "";
  const paragraphs = [
    "I hope this email finds you well.",
    `As ${holidayName} approaches${where} on ${date}, I wanted to remind you of this upcoming holiday.`,
    `If you would like your Virtual Assistant to work on ${date}, we'd be happy to accommodate this. Please note that any hours worked on this day will be considered paid overtime and will be included in your next invoice.`,
    answer
      ? "To ensure accurate billing in the next cycle, kindly let us know if you'd like your VA to work on this day by choosing one option below."
      : "To ensure accurate billing in the next cycle, kindly let us know if you'd like your VA to work on this day.",
    "Thank you for your understanding. Should you have any questions or need further assistance, please feel free to reach out.",
  ];
  const subject = `Upcoming public holiday: ${holidayName}, ${date}`;
  const workUrl = answer ? holidayResponseUrl(answer.appUrl, answer.token, "work") : "";
  const offUrl = answer ? holidayResponseUrl(answer.appUrl, answer.token, "off") : "";
  const text = [
    `Dear ${clientName},`,
    "",
    `${paragraphs[0]} ${paragraphs[1]}`,
    "",
    ...paragraphs.slice(2, 4).flatMap((paragraph) => [paragraph, ""]),
    ...(answer ? [`Work on holiday: ${workUrl}`, `Do not work: ${offUrl}`, ""] : []),
    ...paragraphs.slice(4).flatMap((paragraph) => [paragraph, ""]),
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const paragraph = (value: string) =>
    `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${value}</p>`;
  const html = renderCompanyEmail({
    company: branding,
    preheader: `${holidayName} is on ${date}. Would you like your Virtual Assistant to work?`,
    label: "Holiday",
    title: `${holidayName} is coming up`,
    introHtml: escapeEmailHtml(state ? `${date} · ${state}` : date),
    contentHtml: [
      paragraph(`Dear ${escapeEmailHtml(clientName)},`),
      paragraph(escapeEmailHtml(`${paragraphs[0]} ${paragraphs[1]}`)),
      ...paragraphs.slice(2, 4).map((value) => paragraph(escapeEmailHtml(value))),
      answer ? answerButtons(workUrl, offUrl) : "",
      ...paragraphs.slice(4).map((value) => paragraph(escapeEmailHtml(value))),
      `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`,
    ].join(""),
    accentColor: "#7c3aed",
    repliesWelcome: true,
  });
  return { company: branding, subject, text, html };
}

/** "Work on Holiday" and "Do Not Work", as buttons that work in every mail app. */
function answerButtons(workUrl: string, offUrl: string): string {
  const button = (url: string, label: string, background: string) =>
    `<td style="padding: 0 10px 10px 0;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${background}" style="border-radius: 8px;"><a href="${escapeEmailHtml(url)}" style="display: inline-block; padding: 13px 22px; color: #ffffff; font-size: 15px; line-height: 18px; font-weight: 700; text-decoration: none;">${label}</a></td></tr></table></td>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 4px 0 14px;"><tr>${button(workUrl, "Work on Holiday", "#16a34a")}${button(offUrl, "Do Not Work", "#475569")}</tr></table>`;
}

export async function sendHolidayEmails({
  holidays,
  employees,
  companies,
  departments,
  appUrl,
  saveClientQuestion,
  fetchImpl = fetch,
}: {
  holidays: CompanyHoliday[];
  employees: Employee[];
  companies: Company[];
  departments: Department[];
  appUrl: string;
  /**
   * Saves where the client's answer goes and returns its token, or null when it
   * could not be saved; that client is then asked to reply instead.
   */
  saveClientQuestion?: (
    company: Company,
    holiday: CompanyHoliday,
    vas: { id: string; name: string; email: string }[],
  ) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<HolidayEmailResult> {
  if (holidays.length === 0) return { ok: false, status: 404, error: "Holiday not found" };
  const plans = planHolidayEmails(holidays, employees);
  const clientPlans = planClientHolidayEmails(holidays, employees, companies);
  // Any n8n workflow that mails email.to works; the report workflow is one.
  const webhookUrl =
    process.env.N8N_HOLIDAY_WEBHOOK_URL ||
    process.env.N8N_LEAVE_TEAM_WEBHOOK_URL ||
    process.env.N8N_REPORT_WEBHOOK_URL ||
    "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";

  // People whose client is asked whether they work: they are told a decision will follow.
  const askedAbout = new Set(
    clientPlans.flatMap((plan) => plan.days.flatMap((day) => day.vas.map((va) => va.id))),
  );

  let sent = 0;
  let failed = 0;
  // A few at a time, so a big team does not flood the webhook.
  for (let index = 0; index < plans.length; index += 5) {
    await Promise.all(
      plans.slice(index, index + 5).map(async (plan) => {
        const email = buildHolidayEmail(
          plan,
          companies,
          departments,
          askedAbout.has(plan.employee.id),
        );
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
  // Each client that has people off is asked, once per holiday, on its own client email.
  let clients = 0;
  for (const plan of clientPlans) {
    let reached = false;
    for (const { holiday, vas } of plan.days) {
      const token = await saveClientQuestion?.(plan.company, holiday, vas).catch(() => null);
      const email = buildClientHolidayEmail(
        plan.company,
        holiday,
        token ? { appUrl, token } : undefined,
      );
      try {
        const response = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "holiday_client_notice",
            company: email.company,
            holidays: [{ id: holiday.id, date: holiday.date, name: holiday.name }],
            email: {
              to: plan.to.join(","),
              subject: email.subject,
              text: email.text,
              html: email.html,
            },
          }),
        });
        if (response.ok) reached = true;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    if (reached) clients += 1;
  }
  if (plans.length + clientPlans.length > 0 && sent + clients === 0) {
    return { ok: false, status: 502, error: "The n8n webhook did not accept the holiday emails" };
  }
  return { ok: true, sent, failed, clients };
}
