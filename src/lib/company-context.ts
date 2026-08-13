import {
  COMPANY_ID,
  type Company,
  type CompanyMembership,
  type Employee,
  type Punch,
} from "./types.ts";

const DEFAULT_REQUIRED_WORK_MINUTES = 8 * 60;

export function getEmployeeCompanyIds(employee: Employee | null | undefined): string[] {
  if (!employee) return [];
  const ids = new Set<string>();
  if (employee.companyId) ids.add(employee.companyId);
  employee.companyIds?.forEach((companyId) => companyId && ids.add(companyId));
  Object.entries(employee.companyMemberships || {}).forEach(([companyId, membership]) => {
    if (membership.status !== "inactive") ids.add(membership.companyId || companyId);
  });
  if (ids.size === 0) ids.add(COMPANY_ID);
  return [...ids];
}

export function getCompanyMembership(employee: Employee, companyId: string): CompanyMembership {
  const configured = employee.companyMemberships?.[companyId];
  if (configured) return { ...configured, companyId };

  return {
    companyId,
    role: "employee",
    status: "active",
    requiredWorkMinutes: employee.requiredWorkMinutes,
    shiftStartTime: employee.shiftStartTime,
    shiftEndTime: employee.shiftEndTime,
    shiftTimezone: employee.shiftTimezone,
    workingDays: employee.workingDays,
    departmentId: employee.deptId,
  };
}

export function getEmployeeForCompany(employee: Employee, companyId: string): Employee {
  const membership = getCompanyMembership(employee, companyId);
  return {
    ...employee,
    companyId,
    requiredWorkMinutes: membership.requiredWorkMinutes ?? employee.requiredWorkMinutes,
    shiftStartTime: membership.shiftStartTime || employee.shiftStartTime,
    shiftEndTime: membership.shiftEndTime || employee.shiftEndTime,
    shiftTimezone: membership.shiftTimezone || employee.shiftTimezone,
    workingDays: membership.workingDays || employee.workingDays,
    deptId: membership.departmentId || employee.deptId,
  };
}

export function getRequiredWorkMinutes(employee: Employee, company?: Company | null): number {
  const configured = employee.requiredWorkMinutes;
  if (Number.isFinite(configured) && configured! > 0) return Math.round(configured!);
  const companyMinutes = Number(company?.defaultShiftHours) * 60;
  if (Number.isFinite(companyMinutes) && companyMinutes > 0) return Math.round(companyMinutes);
  return DEFAULT_REQUIRED_WORK_MINUTES;
}

export function getPunchCompanyId(punch: Punch, employee?: Employee | null): string {
  return punch.companyId || employee?.companyIds?.[0] || employee?.companyId || COMPANY_ID;
}

export function buildCompanyMembership(
  companyId: string,
  input: Partial<CompanyMembership>,
): CompanyMembership {
  return {
    companyId,
    role: input.role || "employee",
    status: input.status || "active",
    requiredWorkMinutes: Math.max(
      1,
      Math.round(input.requiredWorkMinutes || DEFAULT_REQUIRED_WORK_MINUTES),
    ),
    shiftStartTime: input.shiftStartTime || "09:00",
    shiftEndTime: input.shiftEndTime || "17:00",
    shiftTimezone: input.shiftTimezone || "Australia/Sydney",
    workingDays: input.workingDays || [0, 1, 2, 3, 4, 5],
    departmentId: input.departmentId,
    joinedAt: input.joinedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
