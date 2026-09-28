import { companyEmailBranding, type CompanyEmailBranding } from "./email-branding.ts";
import {
  escapeEmailHtml,
  formatEmailDate,
  renderCompanyEmail,
  renderEmailDetails,
} from "./email-template.ts";
import type { Company } from "./types.ts";

/**
 * A client's answer to "will your VA work this holiday?", saved under a random
 * token that only the client's email carries. The client picks from the email,
 * confirms on a page, and the VA and the accounts team are told.
 *
 * Opening the link never decides anything: mail scanners open links too, so the
 * choice is only saved when the client presses the button on the page.
 */

export type HolidayDecision = "work" | "off";

export interface HolidayResponse {
  companyId: string;
  companyName: string;
  company: CompanyEmailBranding;
  holidayId: string;
  holidayName: string;
  date: string;
  /** The VAs the holiday gives the day to at this client. */
  vas: { id: string; name: string; email: string }[];
  /** Who at the office hears the answer: the admin who sent the notice. */
  notifyEmail?: string;
  decision: HolidayDecision | null;
  decidedAt?: string;
  createdAt: string;
}

export function newResponseToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function isResponseToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

export function holidayResponseUrl(appUrl: string, token: string, choice: HolidayDecision) {
  return `${appUrl.replace(/\/$/, "")}/holiday-response/${token}?choice=${choice}`;
}

export function describeDecision(decision: HolidayDecision): string {
  return decision === "work" ? "VA will work on the holiday" : "VA will take the holiday off";
}

const signOff = `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`;
const paragraph = (value: string) =>
  `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${escapeEmailHtml(value)}</p>`;

/** The VA's email when their client asks them to work the holiday. */
export function buildVaWorkEmail(response: HolidayResponse, va: { name: string }) {
  const firstName = va.name.trim().split(/\s+/)[0] || "there";
  const date = formatEmailDate(response.date);
  const subject = `Please work on ${response.holidayName}, ${date}`;
  const lines = [
    `${response.holidayName} on ${date} is a holiday, but ${response.companyName} has asked you to work that day.`,
    "Please work your usual hours for them and punch in as normal. The hours count as holiday work, not regular hours.",
    "If you cannot work that day, please let us know as soon as possible.",
  ];
  const text = [
    `Hi ${firstName},`,
    "",
    ...lines.flatMap((line) => [line, ""]),
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const html = renderCompanyEmail({
    company: response.company,
    preheader: lines[0],
    label: "Holiday",
    title: "Your client asked you to work",
    introHtml: escapeEmailHtml(`Hi ${firstName}, ${response.holidayName} · ${date}`),
    contentHtml: [
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px;">${renderEmailDetails(
        [
          { label: "Holiday", value: `${response.holidayName}, ${date}` },
          { label: "Client", value: response.companyName },
          { label: "Their answer", value: "Please work this day" },
        ],
        "#16a34a",
      )}</table>`,
      ...lines.map(paragraph),
      signOff,
    ].join(""),
    accentColor: "#16a34a",
  });
  return { subject, text, html };
}

/** The office's email with the client's answer, for billing. */
export function buildDecisionNoticeEmail(response: HolidayResponse, decision: HolidayDecision) {
  const date = formatEmailDate(response.date);
  const names = response.vas.map((va) => va.name).join(", ") || "their VA";
  const subject = `${response.companyName}: ${decision === "work" ? "VA will work" : "VA is off"} on ${response.holidayName}, ${date}`;
  const summary =
    decision === "work"
      ? `${response.companyName} wants ${names} to work on ${response.holidayName}, ${date}. The hours are paid overtime for the next invoice.${response.vas.some((va) => va.email) ? " The VA has been emailed." : ""}`
      : `${response.companyName} confirmed ${names} will take ${response.holidayName}, ${date} off.`;
  const text = [summary, "", "Sent by SavyTime from the client's holiday email."].join("\n");
  const html = renderCompanyEmail({
    company: response.company,
    preheader: summary,
    label: "Client answer",
    title: decision === "work" ? "VA will work the holiday" : "VA will take the holiday",
    introHtml: escapeEmailHtml(`${response.companyName} · ${response.holidayName} · ${date}`),
    contentHtml: paragraph(summary),
    accentColor: decision === "work" ? "#16a34a" : "#7c3aed",
  });
  return { subject, text, html };
}

/** The record saved for one client and one holiday when the notice goes out. */
export function newHolidayResponse({
  company,
  holiday,
  vas,
  notifyEmail,
  now = new Date(),
}: {
  company: Company;
  holiday: { id: string; name?: string; date: string };
  vas: { id: string; name: string; email: string }[];
  notifyEmail?: string;
  now?: Date;
}): HolidayResponse {
  return {
    companyId: company.id || "",
    companyName: company.name?.trim() || "Your client",
    company: companyEmailBranding(company, company.id),
    holidayId: holiday.id,
    holidayName: holiday.name?.trim() || "the public holiday",
    date: holiday.date,
    vas,
    ...(notifyEmail ? { notifyEmail } : {}),
    decision: null,
    createdAt: now.toISOString(),
  };
}
