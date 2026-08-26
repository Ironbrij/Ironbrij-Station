import {
  COMPANY_ID,
  type Company,
  type CompanyMembership,
  type Employee,
  type Punch,
  type ShiftInterval,
} from "./types.ts";

const DEFAULT_REQUIRED_WORK_MINUTES = 8 * 60;

export function calculateShiftMinutes(startTime: string, endTime: string): number {
  if (!startTime || !endTime) return DEFAULT_REQUIRED_WORK_MINUTES;
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM))
    return DEFAULT_REQUIRED_WORK_MINUTES;
  let startMinutes = startH * 60 + startM;
  let endMinutes = endH * 60 + endM;
  if (endMinutes <= startMinutes) {
    endMinutes += 1440;
  }
  return endMinutes - startMinutes;
}

export function calculateTotalShiftMinutes(
  isMultipleShift?: boolean,
  shifts?: ShiftInterval[],
  singleStart?: string,
  singleEnd?: string,
  dayOfWeek?: number,
): number {
  if (isMultipleShift && Array.isArray(shifts) && shifts.length > 0) {
    const activeShifts =
      dayOfWeek !== undefined && dayOfWeek >= 0 && dayOfWeek <= 6
        ? shifts.filter((s) => {
            if (!Array.isArray(s.workingDays) || s.workingDays.length === 0) return true;
            return s.workingDays.includes(dayOfWeek);
          })
        : shifts;
    return activeShifts.reduce((sum, s) => sum + calculateShiftMinutes(s.startTime, s.endTime), 0);
  }
  return calculateShiftMinutes(singleStart || "09:00", singleEnd || "17:00");
}

export function calculateShiftEndTime(startTime: string, shiftHours = 8): string {
  if (!startTime) return "17:00";
  const [h, m] = startTime.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return "17:00";
  const totalM = (h * 60 + m + Math.round(shiftHours * 60)) % 1440;
  const endH = String(Math.floor(totalM / 60)).padStart(2, "0");
  const endM = String(totalM % 60).padStart(2, "0");
  return `${endH}:${endM}`;
}

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
    isMultipleShift: employee.isMultipleShift,
    shifts: employee.shifts,
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
    isMultipleShift: membership.isMultipleShift ?? employee.isMultipleShift,
    shifts: membership.shifts || employee.shifts,
    shiftStartTime: membership.shiftStartTime || employee.shiftStartTime,
    shiftEndTime: membership.shiftEndTime || employee.shiftEndTime,
    shiftTimezone: membership.shiftTimezone || employee.shiftTimezone,
    workingDays: membership.workingDays || employee.workingDays,
    deptId: membership.departmentId || employee.deptId,
  };
}

export function getRequiredWorkMinutes(
  employee: Employee,
  company?: Company | null,
  dateOrDayOfWeek?: Date | string | number,
): number {
  if (employee.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    if (dateOrDayOfWeek !== undefined && dateOrDayOfWeek !== null) {
      let dayOfWeek: number = -1;
      if (typeof dateOrDayOfWeek === "number") {
        dayOfWeek = dateOrDayOfWeek;
      } else if (typeof dateOrDayOfWeek === "string") {
        const [y, m, d] = dateOrDayOfWeek.split("-").map(Number);
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
          dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        }
      } else if (dateOrDayOfWeek instanceof Date) {
        dayOfWeek = dateOrDayOfWeek.getDay();
      }

      if (dayOfWeek >= 0 && dayOfWeek <= 6) {
        const fallbackDays = employee.workingDays || company?.workingDays || [0, 1, 2, 3, 4, 5];
        const activeShifts = employee.shifts.filter((s) => {
          const shiftDays =
            Array.isArray(s.workingDays) && s.workingDays.length > 0 ? s.workingDays : fallbackDays;
          return shiftDays.includes(dayOfWeek);
        });
        if (activeShifts.length > 0) {
          return activeShifts.reduce(
            (sum, s) => sum + calculateShiftMinutes(s.startTime, s.endTime),
            0,
          );
        }
        return 0;
      }
    }
    return calculateTotalShiftMinutes(true, employee.shifts);
  }
  const configured = employee.requiredWorkMinutes;
  if (Number.isFinite(configured) && configured! > 0) return Math.round(configured!);
  if (employee.shiftStartTime && employee.shiftEndTime) {
    return calculateShiftMinutes(employee.shiftStartTime, employee.shiftEndTime);
  }
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
  const isMultipleShift = Boolean(input.isMultipleShift);
  const fallbackWorkingDays = input.workingDays || [0, 1, 2, 3, 4, 5];
  const shifts =
    input.shifts && input.shifts.length > 0
      ? input.shifts.map((s) => ({
          ...s,
          workingDays:
            Array.isArray(s.workingDays) && s.workingDays.length > 0
              ? s.workingDays
              : fallbackWorkingDays,
        }))
      : isMultipleShift
        ? [
            { startTime: "04:00", endTime: "07:00", workingDays: fallbackWorkingDays },
            { startTime: "12:00", endTime: "15:00", workingDays: fallbackWorkingDays },
          ]
        : [];

  const shiftStartTime = shifts?.[0]?.startTime || input.shiftStartTime || "09:00";
  const shiftEndTime =
    shifts?.[shifts.length - 1]?.endTime ||
    input.shiftEndTime ||
    calculateShiftEndTime(shiftStartTime, 8);
  const requiredWorkMinutes =
    input.requiredWorkMinutes ??
    calculateTotalShiftMinutes(isMultipleShift, shifts, shiftStartTime, shiftEndTime);

  let resolvedWorkingDays = fallbackWorkingDays;
  if (isMultipleShift && shifts.length > 0) {
    const daysSet = new Set<number>();
    shifts.forEach((s) => {
      if (Array.isArray(s.workingDays)) {
        s.workingDays.forEach((d) => daysSet.add(d));
      }
    });
    if (daysSet.size > 0) {
      resolvedWorkingDays = Array.from(daysSet).sort((a, b) => a - b);
    }
  }

  return {
    companyId: companyId || COMPANY_ID,
    role: input.role || "employee",
    status: input.status || "active",
    requiredWorkMinutes,
    isMultipleShift,
    shifts,
    shiftStartTime,
    shiftEndTime,
    shiftTimezone: input.shiftTimezone || "Australia/Sydney",
    workingDays: resolvedWorkingDays,
    departmentId: input.departmentId || "",
    joinedAt: input.joinedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function cleanFirestoreData<T extends Record<string, any>>(data: T): T {
  if (data === null || data === undefined) return {} as T;
  const result: any = Array.isArray(data) ? [] : {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      result[key] = cleanFirestoreData(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
