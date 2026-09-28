import type { Company } from "./types.ts";

/**
 * Who at a client hears from us, and about what. One list of addresses per
 * company, set on the company, used by every email meant for the client: the
 * weekly attendance report, holidays, and team leave. Each can be switched off.
 */

export type ClientEmailTopic = "weeklyReport" | "holidays" | "leave";

export const CLIENT_EMAIL_TOPICS: { topic: ClientEmailTopic; label: string; hint: string }[] = [
  {
    topic: "weeklyReport",
    label: "Weekly attendance report",
    hint: "Every Monday, last week's hours for their people.",
  },
  {
    topic: "holidays",
    label: "Holidays",
    hint: "When a holiday gives their people a day off.",
  },
  {
    topic: "leave",
    label: "Team leave",
    hint: "When one of their people has leave approved: who and when, never why.",
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

/** Whether the client wants this kind of email. Everything is on until switched off. */
export function clientWants(
  company: Pick<Company, "clientEmailTopics"> | null | undefined,
  topic: ClientEmailTopic,
): boolean {
  return company?.clientEmailTopics?.[topic] !== false;
}

/** The addresses to send this kind of email to, or none. */
export function clientEmailsFor(
  company: Pick<Company, "clientEmails" | "weeklyReportRecipients" | "clientEmailTopics"> | null | undefined,
  topic: ClientEmailTopic,
): string[] {
  return clientWants(company, topic) ? companyClientEmails(company) : [];
}
