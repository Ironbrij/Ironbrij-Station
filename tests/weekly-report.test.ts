import test from "node:test";
import assert from "node:assert/strict";
import { isReportSendDay, resolveReportWeek } from "../src/lib/weekly-report.ts";

const at = (iso: string) => new Date(iso);

test("a run on Saturday reports the week that just finished", () => {
  // Saturday 2026-09-26.
  const week = resolveReportWeek(at("2026-09-26T09:00:00Z"));
  assert.equal(week.from, "2026-09-21");
  assert.equal(week.to, "2026-09-25");
});

test("a run on Sunday still reports that same finished week", () => {
  const week = resolveReportWeek(at("2026-09-27T09:00:00Z"));
  assert.equal(week.from, "2026-09-21");
  assert.equal(week.to, "2026-09-25");
});

test("a run mid-week reports last week, not the week being worked", () => {
  // Wednesday 2026-09-23: this week is unfinished, so report 14-18 Sept.
  const week = resolveReportWeek(at("2026-09-23T09:23:00Z"));
  assert.equal(week.from, "2026-09-14");
  assert.equal(week.to, "2026-09-18");
});

test("Monday reports the week that ended on Friday", () => {
  const week = resolveReportWeek(at("2026-09-28T09:00:00Z"));
  assert.equal(week.from, "2026-09-21");
  assert.equal(week.to, "2026-09-25");
});

test("a missed send can be replayed for an earlier week", () => {
  const week = resolveReportWeek(at("2026-09-26T09:00:00Z"), "UTC", 1);
  assert.equal(week.from, "2026-09-14");
  assert.equal(week.to, "2026-09-18");
});

test("the label names the week for the subject line", () => {
  assert.equal(
    resolveReportWeek(at("2026-09-26T09:00:00Z")).label,
    "Mon 21 Sep - Fri 25 Sep 2026",
  );
});

test("the send day is read in the company's timezone", () => {
  // 2026-09-26T13:00Z is Saturday in Sydney and Saturday in UTC.
  assert.equal(isReportSendDay(at("2026-09-26T13:00:00Z"), "Australia/Sydney"), true);
  // 2026-09-25T15:00Z is still Friday in UTC but already Saturday in Sydney.
  assert.equal(isReportSendDay(at("2026-09-25T15:00:00Z"), "Australia/Sydney"), true);
  assert.equal(isReportSendDay(at("2026-09-25T15:00:00Z"), "UTC"), false);
});
