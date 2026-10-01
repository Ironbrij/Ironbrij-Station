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
import { dstResponseUrl, type DstResponse } from "./dst-response.ts";
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

/** Where a VA's clock is, as a client would say it. */
const COUNTRY_OF_ZONE: Record<string, string> = {
  "Asia/Manila": "the Philippines",
  "Asia/Kathmandu": "Nepal",
  "Asia/Kolkata": "India",
};

/** "Asia/Manila" -> "Manila". */
export function placeName(timezone: string): string {
  return (timezone.split("/").pop() || timezone).replace(/_/g, " ");
}

/**
 * One VA shift around a clock change. The two choices are worked out from the
 * clocks themselves, whatever timezone the shift happens to be saved in:
 *
 * - follow: the hours stay the same on the client's clock, so the VA's own
 *   times move by the change;
 * - keep: the hours stay the same on the VA's own clock (PHT, NPT), so the
 *   hours on the client's clock move instead.
 *
 * Example: a Nepal VA on 8:00 AM – 2:00 PM Sydney time works 3:45 AM – 9:45 AM
 * NPT. When Sydney's clocks go forward, following Sydney means 2:45 AM – 8:45 AM
 * NPT; keeping NPT means 9:00 AM – 3:00 PM Sydney time.
 */
export interface DstScheduleLine {
  /** The VA's employee id. */
  id: string;
  /** Which of their shifts for this client, for a VA with several. */
  shiftIndex: number;
  name: string;
  /** The VA's own address, for their notice. */
  email: string;
  /** "9:00 AM – 5:00 PM" on the client's clock now. */
  clientBefore: string;
  /** Follow: the same hours on the client's clock (so equal to clientBefore). */
  clientAfter: string;
  /** The VA's own clock now. */
  vaBefore: string;
  /** Follow: the VA's own clock after the change. */
  vaAfter: string;
  vaPlace: string;
  /** The VA's own clock, e.g. "Asia/Manila". */
  vaTimezone: string;
  /** "PHT", "NPT", or "Manila time": what the VA's clock is called. */
  vaZone: string;
  /** Keep: the VA's hours (vaBefore) on the client's clock after the change. */
  clientKeep: string;
  /** The clock the shift is saved on in SavyTime, e.g. "Sydney time". */
  savedZone: string;
  /** What SavyTime does by itself when the clocks change, from where the shift is saved. */
  automatic: "follow" | "keep" | "neither";
  /** The saved shift times that give each choice, on the saved clock. */
  savedFollow: string;
  savedKeep: string;
  /** "08:00": the shift's start and end now, on the client's clock and on the VA's. */
  clientStart: string;
  clientEnd: string;
  vaStart: string;
  vaEnd: string;
}

const ZONE_NAMES: Record<string, string> = {
  "Asia/Manila": "PHT",
  "Asia/Kathmandu": "NPT",
  "Asia/Kolkata": "IST",
};

/** "PHT" for Manila, "NPT" for Kathmandu, otherwise "Manila time". */
export function zoneName(timezone: string): string {
  return ZONE_NAMES[timezone] ?? `${placeName(timezone)} time`;
}

/** "07:00": an instant on a timezone's clock, as a saved shift time. */
function clockTime(instant: Date, timezone: string): string {
  const parts = getZonedParts(instant, timezone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
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
    .map((shift, index) => ({ ...shift, timezone, index }))
    .filter(
      (shift) => /^\d{1,2}:\d{2}$/.test(shift.startTime) && /^\d{1,2}:\d{2}$/.test(shift.endTime),
    );
}

/** A shift's start and end instants on a day, read from one timezone's clock. */
function shiftInstants(dateKey: string, start: string, end: string, timezone: string) {
  const startAt = zonedDateTimeToDate(dateKey, start, timezone);
  let endAt = zonedDateTimeToDate(dateKey, end, timezone);
  if (endAt <= startAt) endAt = new Date(endAt.getTime() + 86400000);
  return { startAt, endAt };
}

function rangeOn(span: { startAt: Date; endAt: Date }, timezone: string): string {
  return `${formatInTimezone(span.startAt, timezone)} – ${formatInTimezone(span.endAt, timezone)}`;
}

/** "9:00 AM – 5:00 PM": a shift saved in one timezone, read on another's clock. */
export function formatShiftOn(
  dateKey: string,
  start: string,
  end: string,
  from: string,
  to: string,
): string {
  return rangeOn(shiftInstants(dateKey, start, end, from), to);
}

/** "2 hours", "4 hours 15 minutes": how far one clock is ahead of another at an instant. */
export function clockGap(ahead: string, behind: string, at: Date): string {
  const minutes = offsetMinutes(ahead, at) - offsetMinutes(behind, at);
  const sign = minutes < 0 ? "behind" : "ahead of";
  const total = Math.abs(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const words = [
    hours ? `${hours} ${hours === 1 ? "hour" : "hours"}` : "",
    rest ? `${rest} minutes` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return total === 0 ? "the same time as" : `${words} ${sign}`;
}

/** A VA's hours around the change, on both clocks, and under both choices. */
export function describeDstSchedules(
  employee: Employee,
  companyId: string,
  change: DstChange,
): DstScheduleLine[] {
  const client = change.timezone;
  const va = getEmployeeTimezone(employee);
  const before = shiftDateKey(change.date, -1);
  const after = shiftDateKey(change.date, 1);
  return shiftsFor(employee, companyId, client).map((shift) => {
    const now = shiftInstants(before, shift.startTime, shift.endTime, shift.timezone);
    // Follow: the client's clock times now, on the day after the change.
    const follow = shiftInstants(
      after,
      clockTime(now.startAt, client),
      clockTime(now.endAt, client),
      client,
    );
    // Keep: the VA's own clock times now, on the day after the change.
    const keep = shiftInstants(after, clockTime(now.startAt, va), clockTime(now.endAt, va), va);
    // What the saved shift turns into by itself after the change.
    const itself = shiftInstants(after, shift.startTime, shift.endTime, shift.timezone);
    const same = (a: Date, b: Date) => a.getTime() === b.getTime();
    return {
      id: employee.id,
      shiftIndex: shift.index,
      name: employee.name?.trim() || employee.email,
      email: employee.email?.trim() || "",
      clientBefore: rangeOn(now, client),
      clientAfter: rangeOn(follow, client),
      vaBefore: rangeOn(now, va),
      vaAfter: rangeOn(follow, va),
      vaPlace: placeName(va),
      vaTimezone: va,
      vaZone: zoneName(va),
      clientKeep: rangeOn(keep, client),
      clientStart: clockTime(now.startAt, client),
      clientEnd: clockTime(now.endAt, client),
      vaStart: clockTime(now.startAt, va),
      vaEnd: clockTime(now.endAt, va),
      savedZone: `${placeName(shift.timezone)} time`,
      automatic: same(itself.startAt, follow.startAt)
        ? "follow"
        : same(itself.startAt, keep.startAt)
          ? "keep"
          : "neither",
      savedFollow: rangeOn(follow, shift.timezone),
      savedKeep: rangeOn(keep, shift.timezone),
    };
  });
}

/** One client and their VAs around their next clock change, whether or not they are emailed. */
export interface ClientDstPlan {
  company: Company;
  /** The client's email addresses for daylight saving notices; may be empty. */
  to: string[];
  /** The client's clock, e.g. "Australia/Sydney". */
  timezone: string;
  /** Their next clock change, or null when their clocks never change. */
  change: DstChange;
  schedules: DstScheduleLine[];
  /** VAs with no shift times saved, named without hours. */
  unscheduled: string[];
}

export interface DstScheduleEntry extends Omit<ClientDstPlan, "change"> {
  change: DstChange | null;
}

/**
 * Every active client with active VAs: their clock, their next change within
 * `days` (or none), and each VA's hours around it. The schedule screen lists
 * all of them; the emails go to the ones with a change soon and a client email.
 */
export function planDstSchedule(
  companies: Company[],
  employees: Employee[],
  now: Date,
  days = 366,
): DstScheduleEntry[] {
  const entries: DstScheduleEntry[] = [];
  const changes = new Map<string, DstChange | null>();
  for (const company of companies) {
    if (company.archived || company.status === "archived") continue;
    const id = normalizeCompanyId(company.id);
    const staff = employees
      .filter(
        (employee) => employee.status === "active" && getEmployeeCompanyIds(employee).includes(id),
      )
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    if (staff.length === 0) continue;
    const timezone = companyClockTimezone(company);
    if (!changes.has(timezone)) changes.set(timezone, findDstChange(timezone, now, days));
    const change = changes.get(timezone) ?? null;
    const schedules: DstScheduleLine[] = [];
    const unscheduled: string[] = [];
    for (const employee of staff) {
      const lines = change ? describeDstSchedules(employee, id, change) : [];
      if (lines.length > 0) schedules.push(...lines);
      else unscheduled.push(employee.name?.trim() || employee.email);
    }
    entries.push({
      company,
      to: clientEmailsFor(company, "daylightSaving"),
      timezone,
      change,
      schedules,
      unscheduled,
    });
  }
  return entries.sort(
    (a, b) =>
      (a.change?.date ?? "9999").localeCompare(b.change?.date ?? "9999") ||
      (a.company.name || "").localeCompare(b.company.name || ""),
  );
}

/** Every client whose clocks change within `days`, with active VAs and a client email. */
export function planClientDstEmails(
  companies: Company[],
  employees: Employee[],
  now: Date,
  days = 35,
): ClientDstPlan[] {
  return planDstSchedule(companies, employees, now, days).filter(
    (entry): entry is ClientDstPlan => Boolean(entry.change) && entry.to.length > 0,
  );
}

/** "Keep current PHT schedule", or a plain version when the VAs are in different places. */
export function keepLabel(lines: Pick<DstScheduleLine, "vaZone">[]): string {
  const zones = [...new Set(lines.map((line) => line.vaZone))];
  return zones.length === 1 && !zones[0].endsWith(" time")
    ? `Keep current ${zones[0]} schedule`
    : "Keep their current schedule";
}

export const FOLLOW_LABEL = "Follow my new DST schedule";

/**
 * The client's notice. With `answer`, it carries the two choices as buttons;
 * without (the answer could not be saved) the client is asked to reply.
 */
export function buildClientDstEmail(
  plan: ClientDstPlan,
  answer?: { appUrl: string; token: string },
) {
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
  const keep = keepLabel(plan.schedules);
  const intro = `I hope this email finds you well. ${what}${where} on ${date}, when clocks move ${move} by ${amount}.`;
  // How far ahead of each VA's country the client's clock is, before and after.
  const gaps = [...new Set(plan.schedules.map((line) => line.vaTimezone))].map((vaTimezone) => {
    const before = new Date(`${shiftDateKey(change.date, -1)}T12:00:00Z`);
    const after = new Date(`${shiftDateKey(change.date, 1)}T12:00:00Z`);
    const country = COUNTRY_OF_ZONE[vaTimezone] ?? placeName(vaTimezone);
    return `${clockGap(change.timezone, vaTimezone, after)} ${country} (now ${clockGap(change.timezone, vaTimezone, before).replace(/ (ahead of|behind)$/, "")})`;
  });
  const gapText = gaps.length
    ? `From ${date}, ${state || placeName(change.timezone)} will be ${gaps.join(" and ")}.`
    : "";
  const same = `Your Virtual Assistant will still work the same number of hours. Because they work from a different time zone, please choose which schedule you would like them to follow from ${date}:`;
  const options = [
    `${FOLLOW_LABEL}: your VA keeps the same hours on your clock, so their own start time moves by 1 hour.`,
    `${keep}: your VA keeps the same hours on their own clock, so their hours on your clock move by 1 hour.`,
  ];
  const ask = answer
    ? "Simply press one of the buttons below to let us know."
    : "Simply reply to this email to let us know which you prefer.";
  const close =
    "Thank you for your understanding. Should you have any questions or need further assistance, please feel free to reach out.";
  const followUrl = answer ? dstResponseUrl(answer.appUrl, answer.token, "follow") : "";
  const keepUrl = answer ? dstResponseUrl(answer.appUrl, answer.token, "keep") : "";
  const lineText = (line: DstScheduleLine) => [
    `- ${line.name}: now ${line.clientBefore} your time (${line.vaBefore} ${line.vaZone})`,
    `    ${FOLLOW_LABEL}: ${line.clientAfter} your time (${line.vaAfter} ${line.vaZone})`,
    `    ${keep}: ${line.clientKeep} your time (${line.vaBefore} ${line.vaZone})`,
  ];
  const subject = `${what} on ${date}: please choose your VA's schedule`;
  const text = [
    `Dear ${clientName},`,
    "",
    intro,
    "",
    ...(gapText ? [gapText, ""] : []),
    same,
    "",
    ...options.map((option) => `- ${option}`),
    "",
    ...plan.schedules.flatMap(lineText),
    ...plan.unscheduled.map((name) => `- ${name}`),
    "",
    ask,
    ...(answer ? ["", `${FOLLOW_LABEL}: ${followUrl}`, `${keep}: ${keepUrl}`] : []),
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
  const hours = (client: string, va: string, zone: string, bold = false) =>
    `${bold ? `<strong>${escapeEmailHtml(client)}</strong>` : escapeEmailHtml(client)}<br><span style="color: #718096;">${escapeEmailHtml(`${va} ${zone}`)}</span>`;
  const rows = [
    ...plan.schedules.map(
      (line) => `<tr>
        <td style="${cell} font-weight: 700;">${escapeEmailHtml(line.name)}</td>
        <td style="${cell}">${hours(line.clientBefore, line.vaBefore, line.vaZone)}</td>
        <td style="${cell}">${hours(line.clientAfter, line.vaAfter, line.vaZone, true)}</td>
        <td style="${cell}">${hours(line.clientKeep, line.vaBefore, line.vaZone, true)}</td>
      </tr>`,
    ),
    ...plan.unscheduled.map(
      (name) =>
        `<tr><td style="${cell} font-weight: 700;">${escapeEmailHtml(name)}</td><td style="${cell}" colspan="3">Same hours as agreed</td></tr>`,
    ),
  ].join("");
  const table = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 18px; border-collapse: collapse;">
      <tr><th style="${head}">VA</th><th style="${head}">Now (your time)</th><th style="${head}">${escapeEmailHtml(FOLLOW_LABEL)}</th><th style="${head}">${escapeEmailHtml(keep)}</th></tr>
      ${rows}
    </table>`;
  const button = (url: string, label: string, background: string) =>
    `<td style="padding: 0 10px 10px 0;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${background}" style="border-radius: 8px;"><a href="${escapeEmailHtml(url)}" style="display: inline-block; padding: 13px 20px; color: #ffffff; font-size: 14px; line-height: 18px; font-weight: 700; text-decoration: none;">${escapeEmailHtml(label)}</a></td></tr></table></td>`;
  const buttons = answer
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 14px;"><tr>${button(followUrl, FOLLOW_LABEL, "#0e7490")}${button(keepUrl, keep, "#475569")}</tr></table>`
    : "";
  const html = renderCompanyEmail({
    company: branding,
    preheader: `Clocks move ${move} ${amount} on ${date}. Please choose your VA's schedule.`,
    label: "Daylight saving",
    title: what,
    introHtml: escapeEmailHtml(`${date}: clocks move ${move} ${amount}${where}`),
    contentHtml: [
      paragraph(`Dear ${clientName},`),
      paragraph(intro),
      ...(gapText ? [paragraph(gapText)] : []),
      paragraph(same),
      ...options.map(paragraph),
      table,
      paragraph(ask),
      buttons,
      paragraph(close),
      `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`,
    ].join(""),
    accentColor: "#0e7490",
    maxWidth: 720,
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

/** The record saved for one client's choice when their notice goes out. */
export function newDstResponse(
  plan: ClientDstPlan,
  notifyEmail?: string,
  now = new Date(),
): DstResponse {
  return {
    companyId: plan.company.id || "",
    companyName: plan.company.name?.trim() || "Your client",
    company: companyEmailBranding(plan.company, plan.company.id),
    change: { ...plan.change },
    keepLabel: keepLabel(plan.schedules),
    lines: plan.schedules.map((line) => ({
      id: line.id,
      name: line.name,
      email: line.email,
      clientBefore: line.clientBefore,
      clientAfter: line.clientAfter,
      vaBefore: line.vaBefore,
      vaAfter: line.vaAfter,
      vaZone: line.vaZone,
      clientKeep: line.clientKeep,
      savedZone: line.savedZone,
      automatic: line.automatic,
      savedFollow: line.savedFollow,
      savedKeep: line.savedKeep,
      vaTimezone: line.vaTimezone,
      shiftIndex: line.shiftIndex,
      clientStart: line.clientStart,
      clientEnd: line.clientEnd,
      vaStart: line.vaStart,
      vaEnd: line.vaEnd,
    })),
    ...(notifyEmail ? { notifyEmail } : {}),
    decision: null,
    createdAt: now.toISOString(),
  };
}

export async function sendClientDstEmails({
  plans,
  appUrl = "",
  saveClientQuestion,
  fetchImpl = fetch,
}: {
  plans: ClientDstPlan[];
  appUrl?: string;
  /**
   * Saves where the client's choice goes and returns its token, or null. A
   * client with a saved question chooses first; their VAs are told after.
   */
  saveClientQuestion?: (plan: ClientDstPlan) => Promise<string | null>;
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
  // Clients who could not be given a choice: their VAs are told the new hours now.
  const unasked: ClientDstPlan[] = [];
  for (const plan of plans) {
    const token = appUrl ? await saveClientQuestion?.(plan).catch(() => null) : null;
    if (!token) unasked.push(plan);
    const email = buildClientDstEmail(plan, token ? { appUrl, token } : undefined);
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
  // Then each VA whose own start time moves, once, for all their unasked clients.
  let vas = 0;
  for (const plan of planVaDstEmails(unasked)) {
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
