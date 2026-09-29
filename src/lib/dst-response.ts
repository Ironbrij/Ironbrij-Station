import type { CompanyEmailBranding } from "./email-branding.ts";
import {
  escapeEmailHtml,
  formatEmailDate,
  renderCompanyEmail,
  renderEmailDetails,
} from "./email-template.ts";

/**
 * A client's daylight saving choice: their VA follows the client's new clock
 * (same hours for the client, the VA's own times move) or keeps their current
 * hours on their own clock (the hours on the client's clock move). Saved under a
 * random token only the client's email carries, chosen on a confirm page, and
 * then the VAs and the office are told.
 */

export type DstDecision = "follow" | "keep";

/** One VA shift, under both choices; see DstScheduleLine in dst-email.ts. */
export interface DstResponseLine {
  id: string;
  name: string;
  email: string;
  clientBefore: string;
  clientAfter: string;
  vaBefore: string;
  vaAfter: string;
  vaZone: string;
  clientKeep: string;
}

export interface DstResponse {
  companyId: string;
  companyName: string;
  company: CompanyEmailBranding;
  change: { date: string; kind: "start" | "end"; timezone: string; minutes: number };
  /** "Keep current PHT schedule", as the client saw it. */
  keepLabel: string;
  lines: DstResponseLine[];
  notifyEmail?: string;
  decision: DstDecision | null;
  decidedAt?: string;
  createdAt: string;
}

export function dstResponseUrl(appUrl: string, token: string, choice: DstDecision) {
  return `${appUrl.replace(/\/$/, "")}/dst-response/${token}?choice=${choice}`;
}

export function describeDstDecision(decision: DstDecision, keepLabel: string): string {
  return decision === "follow" ? "Follow my new DST schedule" : keepLabel;
}

const signOff = `<p style="margin: 8px 0 0; font-size: 15px; line-height: 24px; color: #2d3748;">Best regards,<br><strong>Accounts Team</strong></p>`;
const paragraph = (value: string) =>
  `<p style="margin: 0 0 16px; font-size: 15px; line-height: 24px; color: #2d3748;">${escapeEmailHtml(value)}</p>`;
const detailsTable = (rows: { label: string; value: string }[]) =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px;">${renderEmailDetails(rows, "#0e7490")}</table>`;

function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] || "their VA";
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

function changeWords(response: DstResponse) {
  const date = formatEmailDate(response.change.date);
  const what =
    response.change.kind === "start" ? "Daylight Saving Time starts" : "Daylight Saving Time ends";
  const move = response.change.kind === "start" ? "forward" : "back";
  return { date, what, move };
}

/** A VA's hours from the change, under the client's choice. */
function hoursFor(line: DstResponseLine, decision: DstDecision) {
  return decision === "follow"
    ? { va: `${line.vaAfter} ${line.vaZone}`, client: line.clientAfter }
    : { va: `${line.vaBefore} ${line.vaZone}`, client: line.clientKeep };
}

/** The VA's email once their client has chosen. */
export function buildVaDstDecisionEmail(
  response: DstResponse,
  vaLines: DstResponseLine[],
  decision: DstDecision,
) {
  const { date, move } = changeWords(response);
  const firstName = vaLines[0].name.trim().split(/\s+/)[0] || "there";
  const title = `Your Working Hours from ${date}`;
  const subject = `Your working hours for ${response.companyName} from ${date}`;
  const moves = vaLines.some(
    (line) => hoursFor(line, decision).va !== `${line.vaBefore} ${line.vaZone}`,
  );
  const lines = [
    `${response.companyName}'s clocks move ${move} by 1 hour on ${date} for daylight saving. ${response.companyName} has chosen ${
      decision === "follow"
        ? "for you to follow their new DST schedule"
        : "for you to keep your current schedule"
    }.`,
    moves
      ? "Your hours on your own clock change from that day. Please punch in at your new time."
      : "Your hours on your own clock stay the same. Please keep punching in at your usual time.",
    "If you are unable to work these hours, please let us know as soon as possible.",
  ];
  const details = vaLines.flatMap((line) => {
    const hours = hoursFor(line, decision);
    return [
      { label: "Your hours", value: hours.va },
      { label: "Client's clock", value: `${hours.client} (${response.companyName})` },
    ];
  });
  const text = [
    title,
    "",
    `Hi ${firstName},`,
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
    label: "Daylight saving",
    title,
    introHtml: `Hi ${escapeEmailHtml(firstName)},<br>${escapeEmailHtml(`${response.companyName} · ${date}`)}`,
    contentHtml: [detailsTable(details), ...lines.map(paragraph), signOff].join(""),
    accentColor: "#0e7490",
  });
  return { subject, text, html };
}

/**
 * The office's email with the client's choice. When the VA keeps their hours,
 * their shift in SavyTime has to move, so it says to what.
 */
export function buildDstDecisionNoticeEmail(
  response: DstResponse,
  decision: DstDecision,
  vasTold: number,
) {
  const { date, what } = changeWords(response);
  const names = joinNames(response.lines.map((line) => line.name));
  const people = new Set(response.lines.map((line) => line.id)).size;
  const several = people > 1;
  const title =
    decision === "follow"
      ? "Client Chose: Follow New DST Schedule"
      : `Client Chose: ${response.keepLabel}`;
  const heading = `${response.companyName} · ${what} · ${date}`;
  const told =
    vasTold === 0
      ? `${several ? "The VAs have" : "The VA has"} not been emailed, as no email address is saved for them. Please let them know.`
      : vasTold < people
        ? `${vasTold} of the ${people} VAs have been notified by email. Please let the others know.`
        : `${several ? "The VAs have" : "The VA has"} been notified by email.`;
  const lines =
    decision === "follow"
      ? [
          `${response.companyName} has chosen for ${names} to follow their new DST schedule from ${date}.`,
          "Nothing needs to change in SavyTime: the shift stays the same on the client's clock.",
          told,
        ]
      : [
          `${response.companyName} has chosen for ${names} to keep their current schedule from ${date}.`,
          `Please update the shift in SavyTime before ${date}, using the Daylight saving schedule switch on each VA's profile, so it reads as below on ${response.companyName}'s clock.`,
          told,
        ];
  const details =
    decision === "keep"
      ? response.lines.map((line) => ({
          label: line.name,
          value: `${line.clientKeep} (was ${line.clientBefore})`,
        }))
      : [];
  const subject = `${response.companyName}: ${decision === "follow" ? "VA follows new DST schedule" : "VA keeps current schedule"} from ${date}`;
  const text = [
    title,
    "",
    heading,
    "",
    lines[0],
    "",
    lines[1],
    ...(details.length ? ["", ...details.map((detail) => `${detail.label}: ${detail.value}`)] : []),
    "",
    lines[2],
  ].join("\n");
  const html = renderCompanyEmail({
    company: response.company,
    preheader: lines[0],
    label: "Client answer",
    title,
    introHtml: escapeEmailHtml(heading),
    contentHtml: [
      paragraph(lines[0]),
      paragraph(lines[1]),
      details.length ? detailsTable(details) : "",
      paragraph(lines[2]),
    ].join(""),
    accentColor: "#0e7490",
  });
  return { subject, text, html };
}
