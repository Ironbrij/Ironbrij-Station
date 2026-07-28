import type { CompanyNotice } from "./types";

export function getNoticeDeliveryTime(
  notice: Pick<CompanyNotice, "createdAt" | "publishAt">,
): Date {
  return new Date(notice.publishAt || notice.createdAt);
}

export function isNoticePublished(
  notice: Pick<CompanyNotice, "createdAt" | "publishAt">,
  now: Date = new Date(),
): boolean {
  return getNoticeDeliveryTime(notice).getTime() <= now.getTime();
}
