import {
  COMPANY_ID,
  type Company,
  type CompanyMembership,
  type Employee,
  type Punch,
  type ShiftInterval,
} from "./types.ts";

const DEFAULT_REQUIRED_WORK_MINUTES = 8 * 60;

export function normalizeCompanyId(companyId?: string | null): string {
  if (!companyId) return COMPANY_ID;
  const trimmed = companyId.trim();
  if (trimmed.toLowerCase() === "ironbrij" || trimmed.toLowerCase() === "default") {
    return COMPANY_ID;
  }
  return trimmed;
}

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
            return s.workingDays.map(Number).includes(Number(dayOfWeek));
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

  if (Array.isArray(employee.companyMemberships) && employee.companyMemberships.length > 0) {
    (employee.companyMemberships as unknown as CompanyMembership[]).forEach((membership) => {
      if (membership && membership.status !== "inactive" && membership.companyId) {
        ids.add(normalizeCompanyId(membership.companyId));
      }
    });
  } else if (
    employee.companyMemberships &&
    typeof employee.companyMemberships === "object" &&
    Object.keys(employee.companyMemberships).length > 0
  ) {
    Object.entries(employee.companyMemberships).forEach(([companyId, membership]) => {
      if (membership && membership.status !== "inactive") {
        ids.add(normalizeCompanyId(membership.companyId || companyId));
      }
    });
  }

  // Only fall back to companyIds / companyId if companyMemberships was not provided
  if (ids.size === 0) {
    if (employee.companyId) ids.add(normalizeCompanyId(employee.companyId));
    employee.companyIds?.forEach((companyId) => companyId && ids.add(normalizeCompanyId(companyId)));
  }

  if (ids.size === 0) ids.add(COMPANY_ID);
  return [...ids];
}

export function getCompanyMembership(employee: Employee, companyId: string): CompanyMembership {
  const normTarget = normalizeCompanyId(companyId);
  let configured: CompanyMembership | undefined;
  if (Array.isArray(employee.companyMemberships)) {
    configured = (employee.companyMemberships as unknown as CompanyMembership[]).find(
      (m) => m && normalizeCompanyId(m.companyId) === normTarget,
    );
  } else if (employee.companyMemberships && typeof employee.companyMemberships === "object") {
    for (const [key, mem] of Object.entries(employee.companyMemberships)) {
      if (normalizeCompanyId(mem?.companyId || key) === normTarget) {
        configured = mem;
        break;
      }
    }
  }
  if (configured) return { ...configured, companyId: normTarget };

  return {
    companyId: normTarget,
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
  if (!companyId || companyId === "all") return employee;
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
    workingDays:
      Array.isArray(membership.workingDays) && membership.workingDays.length > 0
        ? membership.workingDays
        : employee.workingDays,
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
        const fallbackDays = (employee.workingDays || company?.workingDays || [0, 1, 2, 3, 4, 5]).map(Number);
        const activeShifts = employee.shifts.filter((s) => {
          const shiftDays =
            Array.isArray(s.workingDays) && s.workingDays.length > 0 ? s.workingDays.map(Number) : fallbackDays;
          return shiftDays.includes(Number(dayOfWeek));
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

export function getPunchCompanyId(
  punch: Punch,
  employee?: Employee | null,
  companies: Company[] = [],
): string {
  if (punch.companyId) return normalizeCompanyId(punch.companyId);
  if (punch.companyName) {
    const namedCompany = companies.find(
      (company) => company.name?.trim().toLowerCase() === punch.companyName?.trim().toLowerCase(),
    );
    if (namedCompany?.id) return normalizeCompanyId(namedCompany.id);
  }
  return normalizeCompanyId(employee?.companyId || COMPANY_ID);
}

export function getEmployeePunchesForCompany(
  punches: Punch[],
  employee: Employee | null | undefined,
  companyId: string,
  companyName?: string,
): Punch[] {
  const empIds = employee
    ? new Set([employee.id, employee.authUid].filter(Boolean) as string[])
    : null;
  const targetCId = normalizeCompanyId(companyId);

  return punches.filter((punch) => {
    if (empIds && punch.employeeId && !empIds.has(punch.employeeId)) {
      return false;
    }
    if (punch.companyId) return normalizeCompanyId(punch.companyId) === targetCId;
    if (companyName && punch.companyName) return punch.companyName.trim().toLowerCase() === companyName.trim().toLowerCase();
    return normalizeCompanyId(getPunchCompanyId(punch, employee)) === targetCId;
  });
}

export function buildCompanyMembership(
  companyId: string,
  input: Partial<CompanyMembership>,
): CompanyMembership {
  const isMultipleShift = Boolean(input.isMultipleShift);
  const fallbackWorkingDays = (input.workingDays || [0, 1, 2, 3, 4, 5]).map(Number);
  const shifts =
    input.shifts && input.shifts.length > 0
      ? input.shifts.map((s) => ({
          ...s,
          workingDays:
            Array.isArray(s.workingDays) && s.workingDays.length > 0
              ? s.workingDays.map(Number)
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
        s.workingDays.forEach((d) => daysSet.add(Number(d)));
      }
    });
    if (daysSet.size > 0) {
      resolvedWorkingDays = Array.from(daysSet).sort((a, b) => a - b);
    }
  }

  return {
    companyId: normalizeCompanyId(companyId),
    role: input.role || "employee",
    status: input.status || "active",
    requiredWorkMinutes,
    isMultipleShift,
    shifts,
    shiftStartTime,
    shiftEndTime,
    shiftTimezone: input.shiftTimezone || "Australia/Sydney",
    workingDays: resolvedWorkingDays,
    breakAllowanceMinutes: input.breakAllowanceMinutes ?? 30,
    maxDailyBreaks: input.maxDailyBreaks ?? 1,
    joinedAt: input.joinedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function getEmployeeBreakSettings(
  employee: Employee | null | undefined,
  companyId?: string,
): { allowanceMinutes: number; maxDailyBreaks: number } {
  if (!employee) return { allowanceMinutes: 30, maxDailyBreaks: 1 };
  const membership = companyId ? employee.companyMemberships?.[companyId] : undefined;
  const rawAllowance =
    membership?.breakAllowanceMinutes !== undefined
      ? membership.breakAllowanceMinutes
      : employee.breakAllowanceMinutes !== undefined
        ? employee.breakAllowanceMinutes
        : 30;
  const rawMaxBreaks =
    membership?.maxDailyBreaks !== undefined
      ? membership.maxDailyBreaks
      : employee.maxDailyBreaks !== undefined
        ? employee.maxDailyBreaks
        : 1;

  if (rawAllowance === 0 || rawMaxBreaks === 0) {
    return { allowanceMinutes: 0, maxDailyBreaks: 0 };
  }

  return {
    allowanceMinutes: Math.max(5, rawAllowance),
    maxDailyBreaks: Math.max(1, rawMaxBreaks),
  };
}

export function cleanFirestoreData<T extends Record<string, any>>(data: T): T {
  if (data === null || data === undefined) return {} as T;
  if (typeof data !== "object") return data;
  if (data instanceof Date) return data;
  if (
    typeof (data as any).toMillis === "function" ||
    (data.constructor && data.constructor.name !== "Object" && data.constructor.name !== "Array")
  ) {
    return data;
  }
  const result: any = Array.isArray(data) ? [] : {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      typeof (value as any).toMillis !== "function" &&
      (!value.constructor || value.constructor.name === "Object" || value.constructor.name === "Array")
    ) {
      result[key] = cleanFirestoreData(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
