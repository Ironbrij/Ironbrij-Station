import type { Company } from "./types.ts";

/**
 * Who at a client hears from us, and about what. One list of addresses per
 * company, set on the company, used by every email meant for the client: the
 * weekly and daily attendance reports, holidays, team leave and daylight saving.
 * Each can be switched off, and the daily report has to be switched on.
 */

export type ClientEmailTopic =
  "weeklyReport" | "dailyReport" | "holidays" | "leave" | "daylightSaving";

export const CLIENT_EMAIL_TOPICS: { topic: ClientEmailTopic; label: string; hint: string }[] = [
  {
    topic: "weeklyReport",
    label: "Weekly attendance report",
    hint: "Every Monday, last week's hours for their people.",
  },
  {
    topic: "dailyReport",
    label: "Daily attendance report",
    hint: "Each working day, once every VA's shift has finished. Off until you switch it on.",
  },
  {
    topic: "holidays",
    label: "Holidays",
    hint: "Before a holiday, asking whether their Virtual Assistant should work it.",
  },
  {
    topic: "leave",
    label: "Team leave",
    hint: "When one of their people has leave approved: who and when, never why.",
  },
  {
    topic: "daylightSaving",
    label: "Daylight saving",
    hint: "Before their clocks change, with each VA's hours before and after.",
  },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Addresses typed as one line, split on commas, semicolons or spaces. */
export function parseClientEmails(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [
    ...new Set(
      list
        .flatMap((item) => String(item).split(/[\s,;]+/))
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length <= 254 && EMAIL.test(item)),
    ),
  ];
}

/** The client's addresses. Companies set up before this used the weekly report's list. */
export function companyClientEmails(
  company: Pick<Company, "clientEmails" | "weeklyReportRecipients"> | null | undefined,
): string[] {
  return parseClientEmails(company?.clientEmails ?? company?.weeklyReportRecipients);
}

/** Topics that arrive often enough that a client has to ask for them. */
const OPT_IN_TOPICS: ClientEmailTopic[] = ["dailyReport"];

/**
 * Whether the client wants this kind of email. Everything is on until switched
 * off, except the daily report, which stays off until it is switched on.
 */
export function clientWants(
  company: Pick<Company, "clientEmailTopics"> | null | undefined,
  topic: ClientEmailTopic,
): boolean {
  const chosen = company?.clientEmailTopics?.[topic];
  return OPT_IN_TOPICS.includes(topic) ? chosen === true : chosen !== false;
}

/** The addresses to send this kind of email to, or none. */
export function clientEmailsFor(
  company:
    | Pick<Company, "clientEmails" | "weeklyReportRecipients" | "clientEmailTopics">
    | null
    | undefined,
  topic: ClientEmailTopic,
): string[] {
  return clientWants(company, topic) ? companyClientEmails(company) : [];
}
