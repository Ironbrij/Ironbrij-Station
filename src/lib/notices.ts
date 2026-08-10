import { COMPANY_ID, type CompanyNotice, type Employee } from "./types";

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

export function noticeMatchesEmployee(notice: CompanyNotice, employee?: Employee | null): boolean {
  if (!notice.targetType || notice.targetType === "all") return true;
  if (!employee) return false;

  if (notice.targetType === "companies") {
    const companyIds = [employee.companyId, ...(employee.companyIds || [])].filter(
      (id): id is string => Boolean(id),
    );
    if (companyIds.length === 0) companyIds.push(COMPANY_ID);
    return Boolean(notice.targetCompanyIds?.some((id) => companyIds.includes(id)));
  }

  if (notice.targetType === "dept") {
    return Boolean(
      employee.deptId &&
      (notice.targetDeptId === employee.deptId || notice.targetDeptIds?.includes(employee.deptId)),
    );
  }

  if (notice.targetType === "states") {
    return Boolean(notice.targetStateCodes?.includes(employee.state?.trim() || "N/A"));
  }

  if (notice.targetType === "employee") {
    const employeeIds = [employee.id, employee.authUid].filter((id): id is string => Boolean(id));
    return employeeIds.some(
      (id) => notice.targetEmployeeId === id || notice.targetEmployeeIds?.includes(id),
    );
  }

  return false;
}
