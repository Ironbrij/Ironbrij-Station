import test from "node:test";
import assert from "node:assert/strict";
import { sendHolidayEmails } from "../src/lib/holiday-email.ts";
import { sharedCalendar } from "../src/lib/holidays.ts";
import { COMPANY_ID, type Company, type Employee } from "../src/lib/types.ts";

const companies = [
  { id: COMPANY_ID, name: "Main", isMain: true, defaultShiftHours: 8, workingDays: [1], holidays: [],
    holidayAssignments: [
      { id: "nsw-labour", date: "2026-10-05", name: "Labour Day", targetType: "states", stateCodes: ["NSW"] },
    ] },
  { id: "alpha", name: "Alpha", state: "NSW", defaultShiftHours: 8, workingDays: [1], holidays: [] },
  { id: "beta", name: "Beta", state: "VIC", defaultShiftHours: 8, workingDays: [1], holidays: [] },
] as Company[];

const person = (id: string, email: string, companyIds: string[], status = "active") =>
  ({ id, name: `${id} Person`, email, companyId: companyIds[0], companyIds, status, inviteStatus: "accepted" }) as Employee;

test("each person given the holiday gets their own email through the webhook", async () => {
  const calls: { to: string; subject: string; text: string; event: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ to: body.email.to, subject: body.email.subject, text: body.email.text, event: body.event });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const calendar = sharedCalendar(companies)!;
  const result = await sendHolidayEmails({
    holidays: calendar.holidayAssignments!,
    employees: [
      person("maria", "maria@example.com", ["alpha", "beta"]),
      person("vic", "vic@example.com", ["beta"]),
      person("gone", "gone@example.com", ["alpha"], "inactive"),
    ],
    companies,
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: 1, failed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "maria@example.com");
  assert.equal(calls[0].event, "holiday_notice");
  assert.match(calls[0].subject, /Labour Day/);
  // She also works for Beta in VIC, so the email says which work is off.
  assert.match(calls[0].text, /your work for Alpha only/);
  assert.match(calls[0].text, /other companies on the same day is a normal working day/);
});

test("a webhook that refuses every email is reported", async () => {
  const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  const result = await sendHolidayEmails({
    holidays: sharedCalendar(companies)!.holidayAssignments!,
    employees: [person("maria", "maria@example.com", ["alpha"])],
    companies,
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  assert.equal(result.ok, false);
});
