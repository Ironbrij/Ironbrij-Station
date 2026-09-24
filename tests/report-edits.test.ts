import test from "node:test";
import assert from "node:assert/strict";
import {
  applyReportEdits,
  clearDayEdit,
  clearRowFields,
  editDay,
  editRowFields,
  hasReportEdits,
  NO_REPORT_EDITS,
  readReportEdits,
  removeReportRow,
  reportEditsDocId,
  totalsFromDays,
} from "../src/lib/report-edits.ts";
import type { DailyIntervalRecord, ReportRow } from "../src/lib/report-rows.ts";

function day(date: string, overrides: Partial<DailyIntervalRecord> = {}): DailyIntervalRecord {
  return {
    date,
    dayOfWeek: "Mon",
    scheduledShift: "09:00–17:00",
    isMissingPunchOut: false,
    isAutoPunchOut: false,
    minutesLate: 0,
    breakMinutes: 0,
    unloggedBreakMinutes: 0,
    regularHours: 8,
    rawOvertimeHours: 0,
    isOvertimeApproved: false,
    overtimeStatus: "none",
    status: "Complete",
    ...overrides,
  };
}

function row(id: string, overrides: Partial<ReportRow> = {}): ReportRow {
  const dailyIntervals = overrides.dailyIntervals || [day("2026-09-14"), day("2026-09-15")];
  return {
    id,
    worked: true,
    employeeName: id,
    department: "General",
    role: "V.A.",
    client: "Brefni",
    status: "active",
    hoursPerDay: 8,
    workedDays: dailyIntervals.length,
    absentDays: 0,
    lateDays: 0,
    leaveDays: 0,
    ...totalsFromDays(dailyIntervals),
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    paidLeaveUsed: "0",
    unpaidLeaveUsed: "0",
    availableLeaveCredit: "",
    remarks: "",
    dailyIntervals,
    ...overrides,
  };
}

test("a typed field shows over the live row while the rest stays live", () => {
  const edits = editRowFields(NO_REPORT_EDITS, "ann", {
    availableLeaveCredit: "7.54 Days (60.32 hours)",
  });
  const [first] = applyReportEdits([row("ann")], edits);
  assert.equal(first.availableLeaveCredit, "7.54 Days (60.32 hours)");
  assert.equal(first.isAdjusted, true);

  // New punches still reach the hours nobody typed over.
  const [later] = applyReportEdits(
    [row("ann", { dailyIntervals: [day("2026-09-14"), day("2026-09-15"), day("2026-09-16")] })],
    edits,
  );
  assert.equal(later.regularHours, 24);
  assert.equal(later.availableLeaveCredit, "7.54 Days (60.32 hours)");
});

test("a day edit moves the row totals with it, replacing totals typed over", () => {
  let edits = editRowFields(NO_REPORT_EDITS, "ann", { regularHours: 99 });
  edits = editDay(edits, "ann", "2026-09-15", { regularHours: 6.5 });
  const [shown] = applyReportEdits([row("ann")], edits);
  assert.equal(shown.regularHours, 14.5);
  assert.deepEqual(
    shown.dailyIntervals.map((d) => d.regularHours),
    [8, 6.5],
  );
});

test("a day added by hand joins the row in date order", () => {
  const edits = editDay(
    NO_REPORT_EDITS,
    "ann",
    "2026-09-13",
    day("2026-09-13", { regularHours: 4 }),
  );
  const [shown] = applyReportEdits([row("ann")], edits);
  assert.deepEqual(
    shown.dailyIntervals.map((d) => d.date),
    ["2026-09-13", "2026-09-14", "2026-09-15"],
  );
  assert.equal(shown.regularHours, 20);
  assert.equal(shown.workedDays, 3);
});

test("a fixed punch releases the hours typed over that day", () => {
  const edits = clearDayEdit(
    editDay(NO_REPORT_EDITS, "ann", "2026-09-15", { regularHours: 2 }),
    "ann",
    "2026-09-15",
  );
  assert.equal(hasReportEdits(edits), false);
  assert.equal(applyReportEdits([row("ann")], edits)[0].regularHours, 16);
});

test("clearing a typed field brings the calculated value back", () => {
  const edits = clearRowFields(
    editRowFields(NO_REPORT_EDITS, "ann", { worked: false, regularHours: 0 }),
    "ann",
    ["worked", "regularHours"],
  );
  assert.deepEqual(edits.rowEdits, {});
  assert.equal(applyReportEdits([row("ann")], edits)[0].regularHours, 16);
});

test("removing a row hides a calculated one and drops a hand-added one", () => {
  const custom = row("custom-1", { isCustom: true });
  let edits = { ...NO_REPORT_EDITS, customRows: [custom] };
  edits = editRowFields(edits, "ann", { remarks: "note" });
  edits = removeReportRow(edits, "ann");
  edits = removeReportRow(edits, "custom-1");
  assert.deepEqual(edits.removedRowIds, ["ann"]);
  assert.deepEqual(edits.customRows, []);
  assert.deepEqual(edits.rowEdits, {});
  assert.deepEqual(
    applyReportEdits([row("ann"), row("bob")], edits).map((r) => r.id),
    ["bob"],
  );
});

test("hand-added people come first and take edits like any other row", () => {
  const custom = row("custom-1", { isCustom: true, dailyIntervals: [] });
  const edits = editRowFields({ ...NO_REPORT_EDITS, customRows: [custom] }, "custom-1", {
    paidLeaveUsed: "2.5 Days (20 hours)",
  });
  const shown = applyReportEdits([row("ann")], edits);
  assert.deepEqual(
    shown.map((r) => r.id),
    ["custom-1", "ann"],
  );
  assert.equal(shown[0].paidLeaveUsed, "2.5 Days (20 hours)");
});

test("a saved document reads back, even one missing newer fields", () => {
  const saved = readReportEdits({
    rowEdits: { ann: { remarks: "hi" } },
    customRows: [{ id: "custom-1", employeeName: "Temp" }],
    removedRowIds: ["bob", 3],
  });
  assert.deepEqual(saved.rowEdits, { ann: { remarks: "hi" } });
  assert.deepEqual(saved.dayEdits, {});
  assert.deepEqual(saved.removedRowIds, ["bob"]);
  assert.equal(saved.customRows[0].paidLeaveUsed, "0");
  assert.equal(saved.customRows[0].isCustom, true);
  assert.deepEqual(saved.customRows[0].dailyIntervals, []);
  assert.deepEqual(readReportEdits(undefined), NO_REPORT_EDITS);
});

test("edits are kept per company and period", () => {
  assert.equal(reportEditsDocId("all", "2026-09-14", "2026-09-20"), "all__2026-09-14__2026-09-20");
  assert.equal(
    reportEditsDocId("Brefni Pty/Ltd", "2026-09-01", "2026-09-30"),
    "brefni-pty-ltd__2026-09-01__2026-09-30",
  );
});

test("row totals add up the days as listed", () => {
  const totals = totalsFromDays([
    day("2026-09-14", { regularHours: 7.3 }),
    day("2026-09-15", { rawOvertimeHours: 1, isOvertimeApproved: true }),
    day("2026-09-16", { rawOvertimeHours: 0.5, overtimeStatus: "pending" }),
    day("2026-09-17", {
      rawOvertimeHours: 2,
      overtimeStatus: "rejected",
      isOvertimeRejected: true,
    }),
  ]);
  assert.equal(totals.regularHours, 31.3);
  assert.equal(totals.overtimeHours, 1);
  assert.equal(totals.pendingOvertimeHours, 0.5);
  assert.deepEqual(totals.overtimeDates, ["2026-09-15 (+1.0h)"]);
});
