import { getEmployeeTimezone, zonedDateKey } from "./attendance.ts";
import { clientEmailsFor } from "./client-emails.ts";
import { normalizeCompanyId } from "./company-context.ts";
import { companyClockTimezone, formatShiftOn, placeName, shiftsFor } from "./dst-email.ts";
import { companyEmailBranding } from "./email-branding.ts";
import {
  escapeEmailHtml,
  formatEmailDate,
  renderCompanyEmail,
  renderEmailDetails,
} from "./email-template.ts";
import { moveTime } from "./temporary-schedule.ts";
import type { Company, Employee } from "./types.ts";

/**
 * Tells a VA, and each client affected, that a temporary schedule (such as for
 * daylight saving) has started or ended: their hours before and after, on the
 * client's clock and the VA's own.
 */

export interface ScheduleChangeLine {
  company: Company;
  /** "10:00 AM – 6:00 PM" on the client's clock, then on the VA's. */
  clientAfter: string;
  clientBefore: string;
  vaAfter: string;
  vaBefore: string;
  vaPlace: string;
  /** The day the new hours count from, as the client reads it. */
  from: string;
}

/**
 * The hours for each company, from the times saved now. `minutes` is how far
 * the temporary schedule moved them; when it has just ended the saved times are
 * the usual ones again, so "before" is the moved hours.
 */
export function describeScheduleChange(
  employee: Employee,
  companies: Company[],
  companyIds: string[],
  minutes: number,
  started: boolean,
  now: Date,
): ScheduleChangeLine[] {
  const vaTimezone = getEmployeeTimezone(employee);
  const back = started ? -minutes : minutes;
  const lines: ScheduleChangeLine[] = [];
  for (const id of companyIds.map(normalizeCompanyId)) {
    const company = companies.find((item) => normalizeCompanyId(item.id) === id);
    if (!company) continue;
    const clientTimezone = companyClockTimezone(company);
    const today = zonedDateKey(now, clientTimezone);
    for (const shift of shiftsFor(employee, id, clientTimezone)) {
      const before = {
        start: moveTime(shift.startTime, back)!,
        end: moveTime(shift.endTime, back)!,
      };
      lines.push({
        company,
        clientAfter: formatShiftOn(
          today,
          shift.startTime,
          shift.endTime,
          shift.timezone,
          clientTimezone,
        ),
        clientBefore: formatShiftOn(
          today,
          before.start,
          before.end,
          shift.timezone,
          clientTimezone,
        ),
        vaAfter: formatShiftOn(today, shift.startTime, shift.endTime, shift.timezone, vaTimezone),
        vaBefore: formatShiftOn(today, before.start, before.end, shift.timezone, vaTimezone),
        vaPlace: placeName(vaTimezone),
        from: formatEmailDate(today),
      });
    }
  }
  return lines;
}

const signOff = `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`;
const paragraph = (value: string) =>
  `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${escapeEmailHtml(value)}</p>`;
const details = (rows: { label: string; value: string }[]) =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px;">${renderEmailDetails(rows, "#0e7490")}</table>`;

export function buildVaScheduleEmail(
  employee: Employee,
  lines: ScheduleChangeLine[],
  started: boolean,
) {
  const firstName = employee.name?.trim().split(/\s+/)[0] || "there";
  const from = lines[0].from;
  const subject = started
    ? `Your working hours change from ${from}`
    : `Your usual working hours are back from ${from}`;
  const intro = started
    ? `For daylight saving, your working hours change from ${from}. You still work the same number of hours:`
    : `From ${from}, you are back on your usual working hours:`;
  const outro =
    "Please punch in at your new time from that day. If you have any questions, please let us know.";
  const rows = (line: ScheduleChangeLine) => [
    `${line.company.name}`,
    `- New hours: ${line.vaAfter} ${line.vaPlace} time (${line.clientAfter} ${line.company.name} time)`,
    `- Before: ${line.vaBefore} ${line.vaPlace} time (${line.clientBefore} ${line.company.name} time)`,
  ];
  const text = [
    `Hi ${firstName},`,
    "",
    intro,
    "",
    ...lines.flatMap((line) => [...rows(line), ""]),
    outro,
    "",
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const html = renderCompanyEmail({
    company: companyEmailBranding(lines[0].company, lines[0].company.id),
    preheader: subject,
    label: "Schedule",
    title: started ? "Your working hours are changing" : "Back to your usual hours",
    introHtml: escapeEmailHtml(`Hi ${firstName}, from ${from}.`),
    contentHtml: [
      paragraph(intro),
      ...lines.map((line) =>
        details([
          { label: "Client", value: line.company.name },
          { label: "New hours", value: `${line.vaAfter} ${line.vaPlace} time` },
          { label: "Before", value: `${line.vaBefore} ${line.vaPlace} time` },
          { label: "Client clock", value: line.clientAfter },
        ]),
      ),
      paragraph(outro),
      signOff,
    ].join(""),
    accentColor: "#0e7490",
  });
  return { subject, text, html };
}

export function buildClientScheduleEmail(
  employee: Employee,
  company: Company,
  lines: ScheduleChangeLine[],
  started: boolean,
) {
  const vaName = employee.name?.trim() || "Your Virtual Assistant";
  const from = lines[0].from;
  const subject = started
    ? `${vaName}'s working hours change from ${from}`
    : `${vaName} is back on their usual hours from ${from}`;
  const intro = started
    ? `I hope this email finds you well. For daylight saving, ${vaName}'s working hours change from ${from}. They will still work the same number of hours:`
    : `I hope this email finds you well. From ${from}, ${vaName} is back on their usual working hours:`;
  const close =
    "Thank you for your understanding. Should you have any questions or need further assistance, please feel free to reach out.";
  const text = [
    `Dear ${company.name},`,
    "",
    intro,
    "",
    ...lines.flatMap((line) => [
      `- New hours: ${line.clientAfter} your time`,
      `- Before: ${line.clientBefore} your time`,
    ]),
    "",
    close,
    "",
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const html = renderCompanyEmail({
    company: companyEmailBranding(company, company.id),
    preheader: subject,
    label: "Schedule",
    title: started ? `${vaName}'s hours are changing` : `${vaName} is back on usual hours`,
    introHtml: escapeEmailHtml(`From ${from}`),
    contentHtml: [
      paragraph(`Dear ${company.name},`),
      paragraph(intro),
      ...lines.map((line) =>
        details([
          { label: "New hours", value: `${line.clientAfter} your time` },
          { label: "Before", value: `${line.clientBefore} your time` },
        ]),
      ),
      paragraph(close),
      signOff,
    ].join(""),
    accentColor: "#0e7490",
    repliesWelcome: true,
  });
  return { subject, text, html };
}

export async function sendScheduleChangeEmails({
  employee,
  companies,
  companyIds,
  minutes,
  started,
  emailVa = true,
  emailClients = true,
  now = new Date(),
  fetchImpl = fetch,
}: {
  employee: Employee;
  companies: Company[];
  companyIds: string[];
  minutes: number;
  started: boolean;
  emailVa?: boolean;
  emailClients?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ va: boolean; clients: number; failed: number }> {
  const webhookUrl =
    process.env.N8N_DST_WEBHOOK_URL ||
    process.env.N8N_HOLIDAY_WEBHOOK_URL ||
    process.env.N8N_REPORT_WEBHOOK_URL ||
    "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";
  const lines = describeScheduleChange(employee, companies, companyIds, minutes, started, now);
  let failed = 0;
  const post = async (payload: Record<string, unknown>) => {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) return true;
    } catch {
      // Counted below.
    }
    failed += 1;
    return false;
  };
  if (lines.length === 0) return { va: false, clients: 0, failed };

  let va = false;
  if (emailVa && employee.email?.includes("@")) {
    const email = buildVaScheduleEmail(employee, lines, started);
    va = await post({
      event: "schedule_change_va",
      company: companyEmailBranding(lines[0].company, lines[0].company.id),
      employeeName: employee.name,
      email: { to: employee.email.trim(), ...email },
    });
  }
  let clients = 0;
  for (const company of emailClients ? [...new Set(lines.map((line) => line.company))] : []) {
    const to = clientEmailsFor(company, "daylightSaving");
    if (to.length === 0) continue;
    const email = buildClientScheduleEmail(
      employee,
      company,
      lines.filter((line) => line.company === company),
      started,
    );
    if (
      await post({
        event: "schedule_change_client",
        company: companyEmailBranding(company, company.id),
        employeeName: employee.name,
        email: { to: to.join(","), ...email },
      })
    )
      clients += 1;
  }
  return { va, clients, failed };
}
