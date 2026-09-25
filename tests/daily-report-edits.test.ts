import test from "node:test";
import assert from "node:assert/strict";
import {
  REPORT_EDIT_WINDOW_DAYS,
  canEditReport,
  lastReportEditDate,
  mentionsAddedByEdit,
} from "../src/lib/daily-reports.ts";
import type { MentionItem } from "../src/lib/types.ts";

test("a report can be edited until it is four days old", () => {
  assert.equal(REPORT_EDIT_WINDOW_DAYS, 4);
  const report = { reportDate: "2026-09-21" };
  assert.equal(canEditReport(report, "2026-09-21"), true);
  assert.equal(canEditReport(report, "2026-09-25"), true);
  assert.equal(canEditReport(report, "2026-09-26"), false);
});

test("the window runs across month and year ends", () => {
  assert.equal(lastReportEditDate("2026-09-28"), "2026-10-02");
  assert.equal(lastReportEditDate("2026-12-30"), "2027-01-03");
  assert.equal(canEditReport({ reportDate: "2026-12-30" }, "2027-01-03"), true);
});

test("a report dated after today, or with a bad date, cannot be edited", () => {
  assert.equal(canEditReport({ reportDate: "2026-09-26" }, "2026-09-25"), false);
  assert.equal(lastReportEditDate("not-a-date"), "");
  assert.equal(canEditReport({ reportDate: "not-a-date" }, "2026-09-25"), false);
});

const mention = (type: MentionItem["type"], id: string): MentionItem => ({
  id,
  type,
  name: id,
  displayTag: `@${id}`,
});

test("only people newly tagged in an edit are emailed again", () => {
  const before = [mention("person", "ann"), mention("department", "creative")];
  const after = [
    mention("person", "ann"),
    mention("department", "creative"),
    mention("person", "rose"),
    mention("department", "ann"),
  ];
  assert.deepEqual(
    mentionsAddedByEdit(before, after).map((item) => `${item.type}:${item.id}`),
    ["person:rose", "department:ann"],
  );
  assert.deepEqual(mentionsAddedByEdit(after, before), []);
});
