import test from "node:test";
import assert from "node:assert/strict";
import { buildReportCoverMessage } from "../src/lib/report-cover-message.ts";
import { formatLongPeriod } from "../src/lib/report-format.ts";

const ann = {
  employeeName: "Ann Cataring",
  hoursPerDay: 8,
  regularHours: 164.1,
  overtimeHours: 3,
  paidLeaveDays: 4,
  unpaidLeaveDays: 0,
  paidLeaveUsed: "4 Days (32 hours)",
  unpaidLeaveUsed: "0",
  availableLeaveCredit: "3.18 Days (25.46 hours)",
};

test("the cover message is the client letter, written from the report's figures", () => {
  assert.equal(
    buildReportCoverMessage({
      clientName: "Kylie",
      from: "2026-09-01",
      to: "2026-09-30",
      rows: [ann],
    }),
    [
      "Hi Kylie,",
      "",
      "I hope you’re doing well.",
      "",
      "Please see below the attendance summary for September 1–30, 2026.",
      "",
      "Attendance Summary",
      "",
      "VA Name: Ann Cataring",
      "",
      "Total Regular Hours: 164.1 hours",
      "Overtime: 3 hours",
      "Paid Leave Used: 4 days (32 hours)",
      "Unpaid Leave Used: 0 days (0 hours)",
      "Available Leave Credit: 3.18 days (25.46 hours)",
      "",
      "The detailed attendance, overtime, leave records, and remarks are included in the report below for your reference.",
      "",
      "If you have any questions or need any additional information, please feel free to reach out.",
      "",
      "Thank you, and have a great day!",
      "",
      "Best regards,",
      "Accounts Team",
    ].join("\n"),
  );
});

test("every VA on the report gets their own summary", () => {
  const message = buildReportCoverMessage({
    clientName: "Ironbrij",
    from: "2026-09-21",
    to: "2026-09-25",
    rows: [ann, { ...ann, employeeName: "Ben Reyes", regularHours: 40, overtimeHours: 0 }],
  });
  assert.match(message, /VA Name: Ann Cataring\n\nTotal Regular Hours: 164\.1 hours/);
  assert.match(message, /VA Name: Ben Reyes\n\nTotal Regular Hours: 40 hours\nOvertime: 0 hours/);
});

test("blank figures read in full and a blank name still greets", () => {
  const message = buildReportCoverMessage({
    clientName: "  ",
    from: "2026-09-01",
    to: "2026-09-30",
    rows: [
      {
        employeeName: "Cara Lim",
        regularHours: 8,
        overtimeHours: 0,
        paidLeaveDays: 1,
        unpaidLeaveDays: 0.5,
        availableLeaveCredit: "",
      },
    ],
  });
  assert.match(message, /^Hi there,/);
  assert.match(message, /Total Regular Hours: 8 hours/);
  assert.match(message, /Paid Leave Used: 1 day \(8 hours\)/);
  assert.match(message, /Unpaid Leave Used: 0\.5 days \(4 hours\)/);
  assert.match(message, /Available Leave Credit: 0 days \(0 hours\)/);
});

test("the period reads as a letter would say it", () => {
  assert.equal(formatLongPeriod("2026-09-01", "2026-09-30"), "September 1–30, 2026");
  assert.equal(formatLongPeriod("2026-08-31", "2026-09-04"), "August 31 – September 4, 2026");
  assert.equal(formatLongPeriod("2026-12-29", "2027-01-02"), "December 29, 2026 – January 2, 2027");
  assert.equal(formatLongPeriod("2026-09-14", "2026-09-14"), "September 14, 2026");
});
