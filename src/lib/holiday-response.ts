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
  const title = "Your Client Asked You to Work";
  const heading = `${response.holidayName} · ${date}`;
  const subject = `Please work on ${response.holidayName}, ${date}`;
  const details = [
    { label: "Holiday", value: `${response.holidayName}, ${date}` },
    { label: "Client", value: response.companyName },
    { label: "Client’s Response", value: "Please work on this day" },
  ];
  const lines = [
    `${response.holidayName} is a holiday, but ${response.companyName} has requested that you work on this day.`,
    "Please work your usual hours and punch in as normal. The hours worked will be recorded as holiday work and paid as overtime.",
    "If you are unable to work on this day, please let us know as soon as possible.",
  ];
  const text = [
    title,
    "",
    `Hi ${firstName},`,
    "",
    heading,
    "",
    ...details.map((detail) => `${detail.label}: ${detail.value}`),
    "",
    ...lines.flatMap((line) => [line, ""]),
    "Best regards,",
    "Accounts Team",
  ].join("\n");
  const html = renderCompanyEmail({
    company: response.company,
    preheader: lines[0],
    label: "Holiday",
    title,
    introHtml: `Hi ${escapeEmailHtml(firstName)},<br>${escapeEmailHtml(heading)}`,
    contentHtml: [
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px;">${renderEmailDetails(details, "#16a34a")}</table>`,
      ...lines.map(paragraph),
      signOff,
    ].join(""),
    accentColor: "#16a34a",
  });
  return { subject, text, html };
}

/** "Ann Cataring", "Ann Cataring and Ram Thapa", "Ann, Ram and Maria". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] || "their VA";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The office's email with the client's answer, for billing. `vasTold` is how
 * many VAs were actually emailed, so it never claims one was told when not.
 */
export function buildDecisionNoticeEmail(
  response: HolidayResponse,
  decision: HolidayDecision,
  vasTold = 0,
) {
  const date = formatEmailDate(response.date);
  const names = joinNames(response.vas.map((va) => va.name));
  const several = response.vas.length > 1;
  const title =
    decision === "work" ? "VA Will Work on the Holiday" : "VA Will Take the Holiday Off";
  const heading = `${response.companyName} · ${response.holidayName} · ${date}`;
  const lines =
    decision === "work"
      ? [
          `${response.companyName} has requested that ${names} work on ${response.holidayName}, ${date}.`,
          "The hours worked on the holiday will be paid as overtime and included in the next invoice.",
          vasTold === 0
            ? `${several ? "The VAs have" : "The VA has"} not been emailed, as no email address is saved for them. Please let them know.`
            : vasTold < response.vas.length
              ? `${vasTold} of the ${response.vas.length} VAs have been notified by email. Please let the others know.`
              : `${several ? "The VAs have" : "The VA has"} been notified by email.`,
        ]
      : [
          `${response.companyName} has confirmed that ${names} will take ${response.holidayName}, ${date} off.`,
          "No overtime will be billed for this day.",
        ];
  const subject = `${response.companyName}: ${decision === "work" ? "VA will work" : "VA is off"} on ${response.holidayName}, ${date}`;
  const text = [title, "", heading, "", ...lines.flatMap((line) => [line, ""])].join("\n").trim();
  const html = renderCompanyEmail({
    company: response.company,
    preheader: lines[0],
    label: "Client answer",
    title,
    introHtml: escapeEmailHtml(heading),
    contentHtml: lines.map(paragraph).join(""),
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
