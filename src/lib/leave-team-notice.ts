import type { Department, Employee, LeaveRequest } from "./types";

/**
 * Who hears about a colleague's leave, and what they are told.
 *
 * Only approved leave reaches the team: a pending request is between the
 * employee and the admin. The team is told who is away and when, never the
 * reason or whether the leave is paid.
 */

export type LeaveTeamNoticeEvent = "approved" | "revoked";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidNoticeEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

/** Splits a typed list of addresses on commas, semicolons or whitespace. */
export function parseNoticeEmails(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter(isValidNoticeEmail),
    ),
  ];
}

export function findLeaveEmployee(
  leave: Pick<LeaveRequest, "employeeId">,
  employees: Employee[],
): Employee | undefined {
  return (
    employees.find((employee) => employee.id === leave.employeeId) ||
    employees.find((employee) => employee.authUid === leave.employeeId)
  );
}

/**
 * The teams a department tells about leave. One nobody has set up tells its own
 * team, so a department always hears; once an admin picks, that choice holds,
 * even when it is nobody.
 */
export function leaveNotifyTeamIds(department: Department): string[] {
  return department.leaveNotifyDepartmentIds ?? [department.id];
}

/**
 * Everyone the employee's department asks to be told, minus the employee.
 * Members of a listed team count only while active and signed up.
 */
export function resolveLeaveNoticeRecipients(
  employee: Employee,
  departments: Department[],
  employees: Employee[],
): string[] {
  const department = departments.find((item) => item.id === employee.deptId);
  if (!department) return [];

  const teamIds = new Set(leaveNotifyTeamIds(department));
  const emails = new Set<string>();
  for (const member of employees) {
    if (!member.deptId || !teamIds.has(member.deptId)) continue;
    if (member.status !== "active" || member.inviteStatus !== "accepted") continue;
    const email = member.email?.trim().toLowerCase();
    if (email && isValidNoticeEmail(email)) emails.add(email);
  }
  for (const raw of department.leaveNotifyEmails || []) {
    const email = raw.trim().toLowerCase();
    if (isValidNoticeEmail(email)) emails.add(email);
  }
  emails.delete(employee.email?.trim().toLowerCase() || "");
  return [...emails].sort();
}

function formatDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return dateKey;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type LeavePart = Pick<LeaveRequest, "leaveType" | "halfDayPeriod" | "startTime" | "endTime">;

function partOfDay(part: LeavePart): string {
  if (part.leaveType === "half_day") {
    return part.halfDayPeriod === "second_half"
      ? " (second half of the day)"
      : " (first half of the day)";
  }
  if (part.leaveType === "timed_break" && part.startTime && part.endTime) {
    return ` (${part.startTime}–${part.endTime})`;
  }
  return "";
}

/** "on Mon, 5 Oct 2026", "from Mon, 5 Oct 2026 to Wed, 7 Oct 2026", or "on" a list of picked dates. */
export function describeLeaveDates(leave: LeaveRequest): string {
  if (Array.isArray(leave.dates) && leave.dates.length > 0) {
    const days = [...leave.dates].sort((a, b) => a.date.localeCompare(b.date));
    return `on ${days
      .map(
        (day) =>
          `${formatDateKey(day.date)}${partOfDay({
            leaveType: day.leaveType || leave.leaveType,
            halfDayPeriod: day.halfDayPeriod || leave.halfDayPeriod,
            startTime: day.startTime || leave.startTime,
            endTime: day.endTime || leave.endTime,
          })}`,
      )
      .join(", ")}`;
  }
  const range =
    leave.dateFrom === leave.dateTo
      ? `on ${formatDateKey(leave.dateFrom)}`
      : `from ${formatDateKey(leave.dateFrom)} to ${formatDateKey(leave.dateTo)}`;
  return `${range}${partOfDay(leave)}`;
}

export interface LeaveTeamNoticeText {
  subject: string;
  headline: string;
  text: string;
}

export function buildLeaveTeamNoticeText(input: {
  event: LeaveTeamNoticeEvent;
  employeeName: string;
  teamName?: string;
  companyName: string;
  leave: LeaveRequest;
}): LeaveTeamNoticeText {
  const who = input.teamName ? `${input.employeeName} (${input.teamName})` : input.employeeName;
  const when = describeLeaveDates(input.leave);
  const onLeave = input.leave.leaveType === "timed_break" ? "be away" : "be on leave";
  if (input.event === "revoked") {
    const headline = `${who} will no longer ${onLeave} ${when}.`;
    return {
      subject: `Update: ${input.employeeName} will no longer ${onLeave} ${when}`,
      headline,
      text: `Hi team,\n\n${headline} Please plan with them as usual.\n\n${input.companyName}`,
    };
  }
  const headline = `${who} will ${onLeave} ${when}.`;
  return {
    subject: `${input.employeeName} will ${onLeave} ${when}`,
    headline,
    text: `Hi team,\n\n${headline} Please plan around their time away.\n\n${input.companyName}`,
  };
}
