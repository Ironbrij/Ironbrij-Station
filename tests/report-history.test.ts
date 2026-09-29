import test from "node:test";
import assert from "node:assert/strict";
import { buildReportEmail, type SendReportInput } from "../src/lib/report-email.ts";
import { newReportHistoryEntry, reportHistoryId } from "../src/lib/report-history.ts";

const report: SendReportInput = {
  companyId: "ironbrij",
  recipientEmails: ["boss@ironbrij.com"],
  subject: "Ironbrij weekly report (5 Oct - 9 Oct 2026)",
  customMessage: "Hello, here is last week's report.",
  companyName: "Ironbrij",
  clientName: "Ironbrij",
  periodLabel: "5 Oct - 9 Oct 2026",
  periodFrom: "2026-10-05",
  periodTo: "2026-10-09",
  summary: {
    totalHours: 38.456,
    totalOvertime: 2,
    totalPaidLeave: 0,
    totalUnpaidLeave: 0,
    totalEmployees: 1,
  },
  rows: [
    {
      employeeName: "Ann Cataring",
      regularHours: 38.456,
      overtimeHours: 2,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
    },
  ],
};

test("a sent report is kept with its week, recipients, sender and figures", () => {
  const now = new Date("2026-10-12T00:00:00Z");
  const entry = newReportHistoryEntry({
    report,
    recipients: ["boss@ironbrij.com"],
    sentBy: "ann@ironbrij.com.au",
    source: "screen",
    now,
  });
  assert.equal(entry.companyId, "ironbrij");
  assert.equal(entry.from, "2026-10-05");
  assert.equal(entry.to, "2026-10-09");
  assert.deepEqual(entry.recipients, ["boss@ironbrij.com"]);
  assert.equal(entry.sentBy, "ann@ironbrij.com.au");
  assert.equal(entry.sentAt, "2026-10-12T00:00:00.000Z");
  assert.equal(entry.totalHours, 38.46);
  assert.equal(entry.subject, "Ironbrij weekly report (5 Oct - 9 Oct 2026)");
  assert.equal(
    reportHistoryId("ironbrij", "2026-10-05", now),
    `ironbrij-2026-10-05-${now.getTime()}`,
  );
  assert.equal(reportHistoryId("a/b c", "2026-10-05", now), `a-b-c-2026-10-05-${now.getTime()}`);
});

test("a kept report opens again as the same email", () => {
  const entry = newReportHistoryEntry({
    report,
    recipients: ["boss@ironbrij.com"],
    sentBy: "ann@ironbrij.com.au",
    source: "screen",
  });
  const again = buildReportEmail(entry.report, entry.sentBy);
  const original = buildReportEmail(report, "ann@ironbrij.com.au");
  assert.equal(again.html, original.html);
  assert.equal(again.subject, "Ironbrij weekly report (5 Oct - 9 Oct 2026)");
  assert.match(again.html, /Ann Cataring/);
  assert.match(again.html, /Hello, here is last week&#39;s report\./);
});
