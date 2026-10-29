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

test("every weekly report to a client has the same subject, so they share one thread", async () => {
  const { weeklyReportSubject } = await import("../src/lib/report-email.ts");
  assert.equal(weeklyReportSubject("Northwind"), "Northwind VAs Weekly Attendance Report");
  assert.equal(weeklyReportSubject(" Northwind "), weeklyReportSubject("Northwind"));
  assert.equal(weeklyReportSubject(""), "All Clients VAs Weekly Attendance Report");
});

test("every week's report to a client points at the same thread", async () => {
  const { reportThreadHeaders, weeklyReportSubject } = await import("../src/lib/report-email.ts");
  const headers = reportThreadHeaders(weeklyReportSubject("Northwind"));
  assert.deepEqual(headers, {
    References: "<northwind-vas-weekly-attendance-report@station.savykids.com>",
    "In-Reply-To": "<northwind-vas-weekly-attendance-report@station.savykids.com>",
    "Thread-Topic": "Northwind VAs Weekly Attendance Report",
  });
  assert.notEqual(
    reportThreadHeaders(weeklyReportSubject("Contoso")).References,
    headers.References,
  );
});

test("the report workflow puts the thread headers into the email it sends", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = JSON.parse(readFileSync("n8n/report-email.workflow.json", "utf8"));
  const code = workflow.nodes.find((n: { type: string }) => n.type === "n8n-nodes-base.code")
    .parameters.jsCode;
  const email = {
    to: "a@client.com, b@client.com",
    subject: "Café Ltd VAs Weekly Attendance Report",
    html: "<p>Mon 21 Sep - Fri 25 Sep 2026</p>",
    headers: { References: "<x@station.savykids.com>", "Thread-Topic": "Café\r\nBcc: evil@x.com" },
  };
  // Stand-ins for n8n's $ and $input; nothing is sent.
  const run = new Function("$", "$input", "Buffer", code);
  const [{ json }] = run(
    () => ({ first: () => ({ json: { body: { email } } }) }),
    { first: () => ({ json: { emailAddress: "reports@savykids.com" } }) },
    Buffer,
  );
  const mime = Buffer.from(json.raw, "base64url").toString("utf8");
  const [head, body] = mime.split("\r\n\r\n");
  const lines = head.split("\r\n");
  assert.ok(lines.includes("From: SavyTime <reports@savykids.com>"));
  assert.ok(lines.includes("To: a@client.com, b@client.com"));
  assert.ok(lines.includes("References: <x@station.savykids.com>"));
  assert.ok(lines.includes(`Subject: =?UTF-8?B?${Buffer.from(email.subject).toString("base64")}?=`));
  // A line break in a value cannot start a header of its own.
  assert.ok(!lines.some((l) => l.startsWith("Bcc:")));
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), email.html);
});
