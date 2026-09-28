import {
  DEFAULT_SHIFT_TIMEZONE,
  formatInTimezone,
  getEmployeeTimezone,
  getZonedParts,
  isValidTimezone,
  zonedDateKey,
  zonedDateTimeToDate,
} from "./attendance.ts";
import { clientEmailsFor } from "./client-emails.ts";
import {
  getCompanyMembership,
  getEmployeeCompanyIds,
  normalizeCompanyId,
} from "./company-context.ts";
import { companyEmailBranding } from "./email-branding.ts";
import { regionLabel, regionTimezone } from "./holidays.ts";
import {
  escapeEmailHtml,
  formatEmailDate,
  renderCompanyEmail,
  renderEmailDetails,
} from "./email-template.ts";
import type { Company, Employee } from "./types.ts";

/**
 * Daylight saving notices for clients. When a client's clocks move, their VA
 * works the same hours on the client's clock, so the VA's own start time moves
 * by an hour. Each client is told, with every VA's hours before and after, and
 * asked to reply if they would rather keep the VA's current hours.
 */

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

/**
 * The client's clock. Their state or region decides it ("US-CA" is Los
 * Angeles), since a company's timezone is often left at the Sydney default.
 */
export function companyClockTimezone(company: Pick<Company, "state" | "timezone">): string {
  const byState = regionTimezone(company.state?.trim() || "");
  if (byState) return byState;
  return isValidTimezone(company.timezone) ? company.timezone! : DEFAULT_SHIFT_TIMEZONE;
}

/** Minutes ahead of UTC at an instant. */
function offsetMinutes(timezone: string, instant: Date): number {
  const parts = getZonedParts(instant, timezone);
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((local - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

export interface DstChange {
  timezone: string;
  /** The local date the clocks change on. */
  date: string;
  kind: "start" | "end";
  /** How far the clocks move, in minutes; 60 almost everywhere. */
  minutes: number;
}

/** The first clock change in a timezone within `days` of `from`, or null. */
export function findDstChange(timezone: string, from: Date, days = 21): DstChange | null {
  const hour = 3600000;
  const start = Math.floor(from.getTime() / hour) * hour;
  let before = offsetMinutes(timezone, new Date(start));
  for (let step = 1; step <= days * 24; step += 1) {
    const instant = new Date(start + step * hour);
    const after = offsetMinutes(timezone, instant);
    if (after !== before) {
      return {
        timezone,
        date: zonedDateKey(instant, timezone),
        kind: after > before ? "start" : "end",
        minutes: Math.abs(after - before),
      };
    }
    before = after;
  }
  return null;
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** "Asia/Manila" -> "Manila". */
export function placeName(timezone: string): string {
  return (timezone.split("/").pop() || timezone).replace(/_/g, " ");
}

export interface DstScheduleLine {
  name: string;
  /** The VA's own address, for their notice. */
  email: string;
  /** "9:00 AM – 5:00 PM", on the client's clock, before and after the change. */
  clientBefore: string;
  clientAfter: string;
  /** The same hours on the VA's own clock, before and after. */
  vaBefore: string;
  vaAfter: string;
  vaPlace: string;
}

/** Each of a VA's shifts for this client, as start and end times in its timezone. */
export function shiftsFor(employee: Employee, companyId: string, clientTimezone: string) {
  const membership = getCompanyMembership(employee, companyId);
  const timezone = isValidTimezone(membership.shiftTimezone)
    ? membership.shiftTimezone!
    : isValidTimezone(employee.shiftTimezone)
      ? employee.shiftTimezone!
      : clientTimezone;
  const intervals =
    membership.isMultipleShift && membership.shifts?.length
      ? membership.shifts
      : [
          {
            startTime: membership.shiftStartTime || employee.shiftStartTime || "",
            endTime: membership.shiftEndTime || employee.shiftEndTime || "",
          },
        ];
  return intervals
    .filter(
      (shift) => /^\d{1,2}:\d{2}$/.test(shift.startTime) && /^\d{1,2}:\d{2}$/.test(shift.endTime),
    )
    .map((shift) => ({ ...shift, timezone }));
}

/** "9:00 AM – 5:00 PM": a shift saved in one timezone, read on another's clock. */
export function formatShiftOn(
  dateKey: string,
  start: string,
  end: string,
  from: string,
  to: string,
): string {
  const startAt = zonedDateTimeToDate(dateKey, start, from);
  let endAt = zonedDateTimeToDate(dateKey, end, from);
  if (endAt <= startAt) endAt = new Date(endAt.getTime() + 86400000);
  return `${formatInTimezone(startAt, to)} – ${formatInTimezone(endAt, to)}`;
}

/** A VA's hours around the change, on both clocks. */
export function describeDstSchedules(
  employee: Employee,
  companyId: string,
  change: DstChange,
): DstScheduleLine[] {
  const vaTimezone = getEmployeeTimezone(employee);
  const before = shiftDateKey(change.date, -1);
  const after = shiftDateKey(change.date, 1);
  return shiftsFor(employee, companyId, change.timezone).map((shift) => ({
    name: employee.name?.trim() || employee.email,
    email: employee.email?.trim() || "",
    clientBefore: formatShiftOn(
      before,
      shift.startTime,
      shift.endTime,
      shift.timezone,
      change.timezone,
    ),
    clientAfter: formatShiftOn(
      after,
      shift.startTime,
      shift.endTime,
      shift.timezone,
      change.timezone,
    ),
    vaBefore: formatShiftOn(before, shift.startTime, shift.endTime, shift.timezone, vaTimezone),
    vaAfter: formatShiftOn(after, shift.startTime, shift.endTime, shift.timezone, vaTimezone),
    vaPlace: placeName(vaTimezone),
  }));
}

export interface ClientDstPlan {
  company: Company;
  to: string[];
  change: DstChange;
  schedules: DstScheduleLine[];
  /** VAs with no shift times saved, named without hours. */
  unscheduled: string[];
}

/** Every client whose clocks change within `days`, with active VAs and a client email. */
export function planClientDstEmails(
  companies: Company[],
  employees: Employee[],
  now: Date,
  days = 21,
): ClientDstPlan[] {
  const plans: ClientDstPlan[] = [];
  const changes = new Map<string, DstChange | null>();
  for (const company of companies) {
    if (company.archived || company.status === "archived") continue;
    const to = clientEmailsFor(company, "daylightSaving");
    if (to.length === 0) continue;
    const timezone = companyClockTimezone(company);
    if (!changes.has(timezone)) changes.set(timezone, findDstChange(timezone, now, days));
    const change = changes.get(timezone);
    if (!change) continue;
    const id = normalizeCompanyId(company.id);
    const staff = employees
      .filter(
        (employee) => employee.status === "active" && getEmployeeCompanyIds(employee).includes(id),
      )
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (staff.length === 0) continue;
    const schedules: DstScheduleLine[] = [];
    const unscheduled: string[] = [];
    for (const employee of staff) {
      const lines = describeDstSchedules(employee, id, change);
      if (lines.length > 0) schedules.push(...lines);
      else unscheduled.push(employee.name?.trim() || employee.email);
    }
    plans.push({ company, to, change, schedules, unscheduled });
  }
  return plans;
}

export function buildClientDstEmail(plan: ClientDstPlan) {
  const { company, change } = plan;
  const branding = companyEmailBranding(company, company.id);
  const clientName = company.name?.trim() || "there";
  const date = formatEmailDate(change.date);
  const code = company.state?.trim() || "";
  const state = AU_STATE_NAMES[code] || (regionTimezone(code) ? regionLabel(code) : "");
  const where = state ? ` in ${state}` : "";
  const amount = change.minutes === 60 ? "1 hour" : `${change.minutes} minutes`;
  const move = change.kind === "start" ? "forward" : "back";
  const what =
    change.kind === "start" ? "Daylight Saving Time starts" : "Daylight Saving Time ends";
  const intro = `I hope this email finds you well. ${what}${where} on ${date}, when clocks move ${move} by ${amount}.`;
  const same =
    "Your Virtual Assistant will still work the same number of hours. Because they work from a different time zone, their schedule may change by 1 hour. Here is how their hours will look:";
  const ask =
    "If you would like your VA's schedule to stay as it is on their side, or you would like any other change, simply reply to this email and we will arrange it before the change.";
  const close =
    "Thank you for your understanding. Should you have any questions or need further assistance, please feel free to reach out.";
  const lineText = (line: DstScheduleLine) =>
    `${line.name}: ${line.clientAfter} your time from ${date} (${line.vaAfter} ${line.vaPlace} time; before the change ${line.clientBefore} your time, ${line.vaBefore} ${line.vaPlace} time)`;
  const subject = `${what} on ${date}: your VA's hours`;
  const text = [
    `Dear ${clientName},`,
    "",
    intro,
    "",
    same,
    "",
    ...plan.schedules.map((line) => `- ${lineText(line)}`),
    ...plan.unscheduled.map((name) => `- ${name}`),
    "",
    ask,
    "",
    close,
    "",
    "Best regards,",
    "Accounts Team",
  ].join("\n");

  const paragraph = (value: string) =>
    `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${escapeEmailHtml(value)}</p>`;
  const cell =
    "padding: 8px 10px; border-bottom: 1px solid #e7edf4; font-size: 13px; line-height: 19px; color: #2d3748; vertical-align: top;";
  const head =
    "padding: 8px 10px; border-bottom: 2px solid #dfe7f0; font-size: 11px; line-height: 16px; color: #718096; text-align: left; text-transform: uppercase; letter-spacing: 0.04em;";
  const rows = [
    ...plan.schedules.map(
      (line) => `<tr>
        <td style="${cell} font-weight: 700;">${escapeEmailHtml(line.name)}</td>
        <td style="${cell}">${escapeEmailHtml(line.clientBefore)}<br><span style="color: #718096;">${escapeEmailHtml(`${line.vaBefore} ${line.vaPlace}`)}</span></td>
        <td style="${cell}"><strong>${escapeEmailHtml(line.clientAfter)}</strong><br><span style="color: #718096;">${escapeEmailHtml(`${line.vaAfter} ${line.vaPlace}`)}</span></td>
      </tr>`,
    ),
    ...plan.unscheduled.map(
      (name) =>
        `<tr><td style="${cell} font-weight: 700;">${escapeEmailHtml(name)}</td><td style="${cell}" colspan="2">Same hours as agreed</td></tr>`,
    ),
  ].join("");
  const table = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 18px; border-collapse: collapse;">
      <tr><th style="${head}">VA</th><th style="${head}">Before (your time)</th><th style="${head}">From ${escapeEmailHtml(date)}</th></tr>
      ${rows}
    </table>`;
  const html = renderCompanyEmail({
    company: branding,
    preheader: `Clocks move ${move} ${amount} on ${date}. Here is how your VA's hours look.`,
    label: "Daylight saving",
    title: what,
    introHtml: escapeEmailHtml(`${date}: clocks move ${move} ${amount}${where}`),
    contentHtml: [
      paragraph(`Dear ${clientName},`),
      paragraph(intro),
      paragraph(same),
      table,
      paragraph(ask),
      paragraph(close),
      `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`,
    ].join(""),
    accentColor: "#0e7490",
    maxWidth: 680,
    repliesWelcome: true,
  });
  return { company: branding, subject, text, html };
}

export interface VaDstPlan {
  name: string;
  email: string;
  /** Each client whose clocks change, with this VA's hours for them. */
  clients: { company: Company; change: DstChange; lines: DstScheduleLine[] }[];
}

/**
 * The VAs to tell: everyone in these client notices whose own start time moves.
 * One email each, covering every client they work for.
 */
export function planVaDstEmails(plans: ClientDstPlan[]): VaDstPlan[] {
  const byEmail = new Map<string, VaDstPlan>();
  for (const plan of plans) {
    for (const line of plan.schedules) {
      if (!line.email.includes("@") || line.vaBefore === line.vaAfter) continue;
      const key = line.email.toLowerCase();
      const va = byEmail.get(key) ?? { name: line.name, email: line.email, clients: [] };
      byEmail.set(key, va);
      const client = va.clients.find((item) => item.company === plan.company);
      if (client) client.lines.push(line);
      else va.clients.push({ company: plan.company, change: plan.change, lines: [line] });
    }
  }
  return [...byEmail.values()];
}

export function buildVaDstEmail(plan: VaDstPlan) {
  const branding = companyEmailBranding(plan.clients[0].company, plan.clients[0].company.id);
  const firstName = plan.name.split(/\s+/)[0] || "there";
  const changes = plan.clients.map(({ company, change, lines }) => {
    const date = formatEmailDate(change.date);
    const what = change.kind === "start" ? "Daylight saving starts" : "Daylight saving ends";
    return {
      heading: `${company.name}: ${what} on ${date}`,
      rows: lines.map((line) => ({
        before: `${line.vaBefore} ${line.vaPlace} time`,
        after: `${line.vaAfter} ${line.vaPlace} time`,
        client: `${line.clientAfter} on ${company.name}'s clock, same as before`,
        date,
      })),
    };
  });
  const earliest = [...plan.clients].sort((a, b) => a.change.date.localeCompare(b.change.date))[0];
  const subject = `Your working hours change on ${formatEmailDate(earliest.change.date)}`;
  const intro =
    "Your client's clocks are changing for daylight saving. You will work the same number of hours at the same time on your client's clock, so your start and finish times on your own clock move by 1 hour:";
  const outro =
    "Please punch in at your new time from that day. If this new time does not work for you, please let us know as soon as possible.";
  const text = [
    `Hi ${firstName},`,
    "",
    intro,
    "",
    ...changes.flatMap((change) => [
      change.heading,
      ...change.rows.map(
        (row) =>
          `- From ${row.date}: ${row.after} (before: ${row.before}). For your client: ${row.client}.`,
      ),
      "",
    ]),
    outro,
    "",
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const paragraph = (value: string) =>
    `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${escapeEmailHtml(value)}</p>`;
  const html = renderCompanyEmail({
    company: branding,
    preheader: subject,
    label: "Daylight saving",
    title: "Your working hours are changing",
    introHtml: escapeEmailHtml(
      `Hi ${firstName}, same hours for your client, new times on your clock.`,
    ),
    contentHtml: [
      paragraph(intro),
      ...changes.map(
        (change) =>
          `<p style="margin: 0 0 6px; font-size: 14px; line-height: 20px; font-weight: 700; color: #16283f;">${escapeEmailHtml(change.heading)}</p>` +
          renderEmailDetails(
            change.rows.flatMap((row) => [
              { label: "New hours", value: row.after },
              { label: "Before", value: row.before },
              { label: "Client clock", value: row.client },
            ]),
            "#0e7490",
          ).replace(
            /^/,
            '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px;">',
          ) +
          "</table>",
      ),
      paragraph(outro),
      `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`,
    ].join(""),
    accentColor: "#0e7490",
  });
  return { company: branding, subject, text, html };
}

export async function sendClientDstEmails({
  plans,
  fetchImpl = fetch,
}: {
  plans: ClientDstPlan[];
  fetchImpl?: typeof fetch;
}): Promise<{ sent: number; failed: number; vas: number }> {
  // Any n8n workflow that mails email.to works; the report workflow is one.
  const webhookUrl =
    process.env.N8N_DST_WEBHOOK_URL ||
    process.env.N8N_HOLIDAY_WEBHOOK_URL ||
    process.env.N8N_REPORT_WEBHOOK_URL ||
    "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";
  let sent = 0;
  let failed = 0;
  for (const plan of plans) {
    const email = buildClientDstEmail(plan);
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "dst_client_notice",
          company: email.company,
          change: plan.change,
          email: {
            to: plan.to.join(","),
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
  }
  // Then each VA whose own start time moves, once, for all their clients.
  let vas = 0;
  for (const plan of planVaDstEmails(plans)) {
    const email = buildVaDstEmail(plan);
    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "dst_va_notice",
          company: email.company,
          employeeName: plan.name,
          email: { to: plan.email, subject: email.subject, text: email.text, html: email.html },
        }),
      });
      if (response.ok) vas += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { sent, failed, vas };
}
