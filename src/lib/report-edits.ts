import type { DailyIntervalRecord, ReportRow } from "./report-rows.ts";

/**
 * What an admin changed on a report, kept apart from the calculated rows so the
 * live figures keep flowing under every field nobody typed over. It is saved
 * per company and period, so a change survives a reload and reaches every admin.
 */
export interface ReportEdits {
  /** Fields typed over the calculated figures, by row. */
  rowEdits: Record<string, Partial<ReportRow>>;
  /** Days edited or added by hand, by row and then by date. */
  dayEdits: Record<string, Record<string, Partial<DailyIntervalRecord>>>;
  /** People added to the report by hand. */
  customRows: ReportRow[];
  /** Calculated rows taken off the report. */
  removedRowIds: string[];
}

export const NO_REPORT_EDITS: ReportEdits = {
  rowEdits: {},
  dayEdits: {},
  customRows: [],
  removedRowIds: [],
};

/** Row totals that come from its days; a day edit replaces any typed over. */
const DAY_TOTAL_FIELDS = [
  "regularHours",
  "overtimeHours",
  "pendingOvertimeHours",
  "overtimeDates",
  "worked",
  "workedDays",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasReportEdits(edits: ReportEdits): boolean {
  return (
    Object.keys(edits.rowEdits).length > 0 ||
    Object.keys(edits.dayEdits).length > 0 ||
    edits.customRows.length > 0 ||
    edits.removedRowIds.length > 0
  );
}

/** The saved document for one company's report over one period. */
export function reportEditsDocId(companyFilter: string, from: string, to: string): string {
  const company = (companyFilter || "all")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return `${company}__${from}__${to}`;
}

/** Reads a saved document back, tolerating fields an older version never wrote. */
export function readReportEdits(data: unknown): ReportEdits {
  const value = isRecord(data) ? data : {};
  const customRows = Array.isArray(value.customRows) ? value.customRows : [];
  return {
    rowEdits: isRecord(value.rowEdits) ? (value.rowEdits as ReportEdits["rowEdits"]) : {},
    dayEdits: isRecord(value.dayEdits) ? (value.dayEdits as ReportEdits["dayEdits"]) : {},
    customRows: customRows.filter(isRecord).map(
      (row) =>
        ({
          client: "",
          status: "active",
          hoursPerDay: 8,
          overtimeDates: [],
          paidLeaveUsed: "0",
          unpaidLeaveUsed: "0",
          availableLeaveCredit: "",
          remarks: "",
          ...row,
          isCustom: true,
          dailyIntervals: Array.isArray(row.dailyIntervals) ? row.dailyIntervals : [],
        }) as unknown as ReportRow,
    ),
    removedRowIds: Array.isArray(value.removedRowIds)
      ? value.removedRowIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** A row's totals from its days, so a row always adds up to the days shown under it. */
export function totalsFromDays(days: DailyIntervalRecord[]) {
  let regular = 0;
  let approved = 0;
  let pending = 0;
  const overtimeDates: string[] = [];
  for (const day of days) {
    regular += day.regularHours || 0;
    if (day.rawOvertimeHours > 0) {
      if (day.isOvertimeApproved) {
        approved += day.rawOvertimeHours;
        overtimeDates.push(`${day.date} (+${day.rawOvertimeHours.toFixed(1)}h)`);
      } else if (!day.isOvertimeRejected && day.overtimeStatus !== "rejected") {
        pending += day.rawOvertimeHours;
      }
    }
  }
  return {
    regularHours: Math.round(regular * 10) / 10,
    overtimeHours: Math.round(approved * 10) / 10,
    pendingOvertimeHours: Math.round(pending * 10) / 10,
    overtimeDates,
  };
}

/** The report as shown: calculated rows with the admin's edits laid on top. */
export function applyReportEdits(computed: ReportRow[], edits: ReportEdits): ReportRow[] {
  const removed = new Set(edits.removedRowIds);
  return [...edits.customRows, ...computed.filter((row) => !removed.has(row.id))].map((row) => {
    let next = row;
    const days = edits.dayEdits[row.id];
    if (days && Object.keys(days).length > 0) {
      const byDate = new Map(row.dailyIntervals.map((day) => [day.date, day] as const));
      for (const [date, change] of Object.entries(days)) {
        const base = byDate.get(date);
        byDate.set(date, { ...(base || {}), ...change, date } as DailyIntervalRecord);
      }
      const dailyIntervals = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      const totals = totalsFromDays(dailyIntervals);
      next = {
        ...next,
        ...totals,
        dailyIntervals,
        workedDays: dailyIntervals.filter((day) => (day.regularHours || 0) > 0).length,
        worked: totals.regularHours > 0 || totals.overtimeHours > 0,
        isAdjusted: true,
      };
    }
    const fields = edits.rowEdits[row.id];
    return fields ? { ...next, ...fields, isAdjusted: true } : next;
  });
}

export function editRowFields(
  edits: ReportEdits,
  rowId: string,
  fields: Partial<ReportRow>,
): ReportEdits {
  return {
    ...edits,
    rowEdits: { ...edits.rowEdits, [rowId]: { ...edits.rowEdits[rowId], ...fields } },
  };
}

/** Drops typed values so the calculated ones show again. */
export function clearRowFields(
  edits: ReportEdits,
  rowId: string,
  keys: readonly (keyof ReportRow)[],
): ReportEdits {
  const current = edits.rowEdits[rowId];
  if (!current) return edits;
  const remaining = { ...current };
  for (const key of keys) delete remaining[key];
  const rowEdits = { ...edits.rowEdits };
  if (Object.keys(remaining).length > 0) rowEdits[rowId] = remaining;
  else delete rowEdits[rowId];
  return { ...edits, rowEdits };
}

/** A day edit changes the row's totals, so totals typed over the row give way. */
export function editDay(
  edits: ReportEdits,
  rowId: string,
  date: string,
  change: Partial<DailyIntervalRecord>,
): ReportEdits {
  const rowDays = edits.dayEdits[rowId] || {};
  return clearRowFields(
    {
      ...edits,
      dayEdits: {
        ...edits.dayEdits,
        [rowId]: { ...rowDays, [date]: { ...rowDays[date], ...change } },
      },
    },
    rowId,
    DAY_TOTAL_FIELDS,
  );
}

/** Once a day is fixed with real punches, the recalculated day is the truth. */
export function clearDayEdit(edits: ReportEdits, rowId: string, date: string): ReportEdits {
  const rowDays = edits.dayEdits[rowId];
  if (!rowDays?.[date]) return edits;
  const remaining = { ...rowDays };
  delete remaining[date];
  const dayEdits = { ...edits.dayEdits };
  if (Object.keys(remaining).length > 0) dayEdits[rowId] = remaining;
  else delete dayEdits[rowId];
  return { ...edits, dayEdits };
}

export function removeReportRow(edits: ReportEdits, rowId: string): ReportEdits {
  const rowEdits = { ...edits.rowEdits };
  const dayEdits = { ...edits.dayEdits };
  delete rowEdits[rowId];
  delete dayEdits[rowId];
  const isCustom = edits.customRows.some((row) => row.id === rowId);
  return {
    rowEdits,
    dayEdits,
    customRows: edits.customRows.filter((row) => row.id !== rowId),
    removedRowIds:
      isCustom || edits.removedRowIds.includes(rowId)
        ? edits.removedRowIds
        : [...edits.removedRowIds, rowId],
  };
}
