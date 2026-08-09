import type { User } from "firebase/auth";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import type { MentionItem } from "@/lib/types";

export type MentionRecipient = {
  email: string;
  name: string;
  targetName: string;
  targetType: "person" | "department";
};

export type MentionNotificationRequest = {
  company?: CompanyEmailBranding;
  reportId: string;
  reportType?: "sod" | "eod";
  reportDate: string;
  authorName: string;
  authorEmail: string;
  authorDeptName?: string;
  answers: Array<{
    questionId: string;
    question: string;
    answer: string;
    mentions?: MentionItem[];
  }>;
  recipients?: MentionRecipient[];
};

type MentionNotificationResponse = {
  ok?: boolean;
  error?: string;
  mentionsCount?: number;
  recipients?: string[];
};

export async function sendMentionNotification(
  user: User,
  notification: MentionNotificationRequest,
): Promise<MentionNotificationResponse> {
  const idToken = await user.getIdToken();
  const response = await fetch("/api/sod-mention-notification", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(notification),
  });

  const result = (await response.json().catch(() => null)) as MentionNotificationResponse | null;
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.error || `Email notification failed (${response.status})`);
  }

  return result;
}
