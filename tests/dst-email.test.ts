import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClientDstEmail,
  companyClockTimezone,
  findDstChange,
  planClientDstEmails,
  sendClientDstEmails,
} from "../src/lib/dst-email.ts";
import type { Company, Employee } from "../src/lib/types.ts";

const company = (id: string, state: string, extra: Partial<Company> = {}) =>
  ({
    id,
    name: id.toUpperCase(),
    state,
    defaultShiftHours: 8,
    workingDays: [1],
    holidays: [],
    clientEmails: [`boss@${id}.com`],
    ...extra,
  }) as Company;

const va = (id: string, companyIds: string[], extra: Partial<Employee> = {}) =>
  ({
    id,
    name: `${id} VA`,
    email: `${id}@example.com`,
    companyId: companyIds[0],
    companyIds,
    status: "active",
    inviteStatus: "accepted",
    country: "PH",
    timezone: "Asia/Manila",
    shiftTimezone: "Australia/Sydney",
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
    ...extra,
  }) as Employee;

test("Sydney's clocks go forward on the first Sunday of October 2026", () => {
  const change = findDstChange("Australia/Sydney", new Date("2026-09-29T00:00:00Z"));
  assert.deepEqual(change, {
    timezone: "Australia/Sydney",
    date: "2026-10-04",
    kind: "start",
    minutes: 60,
  });
  assert.equal(findDstChange("Australia/Brisbane", new Date("2026-09-29T00:00:00Z")), null);
  const end = findDstChange("Australia/Sydney", new Date("2027-03-20T00:00:00Z"));
  assert.equal(end?.kind, "end");
  assert.equal(end?.date, "2027-04-04");
});

test("a Queensland client left on the Sydney timezone is not told its clocks change", () => {
  assert.equal(
    companyClockTimezone({ state: "QLD", timezone: "Australia/Sydney" }),
    "Australia/Brisbane",
  );
  const plans = planClientDstEmails(
    [company("nsw", "NSW"), company("qld", "QLD", { timezone: "Australia/Sydney" })],
    [va("maria", ["nsw"]), va("jo", ["qld"])],
    new Date("2026-09-29T00:00:00Z"),
  );
  assert.deepEqual(
    plans.map((plan) => plan.company.id),
    ["nsw"],
  );
});

test("the client sees each VA's hours on both clocks, before and after", () => {
  const [plan] = planClientDstEmails(
    [company("nsw", "NSW")],
    [va("maria", ["nsw"]), va("gone", ["nsw"], { status: "inactive" })],
    new Date("2026-09-29T00:00:00Z"),
  );
  assert.deepEqual(plan.schedules, [
    {
      name: "maria VA",
      email: "maria@example.com",
      clientBefore: "9:00 AM – 5:00 PM",
      clientAfter: "9:00 AM – 5:00 PM",
      vaBefore: "7:00 AM – 3:00 PM",
      vaAfter: "6:00 AM – 2:00 PM",
      vaPlace: "Manila",
    },
  ]);
  const email = buildClientDstEmail(plan);
  assert.equal(
    email.subject,
    "Daylight Saving Time starts on Sunday, 4 October 2026: your VA's hours",
  );
  assert.match(email.text, /^Dear NSW,/);
  assert.match(
    email.text,
    /starts in New South Wales on Sunday, 4 October 2026, when clocks move forward by 1 hour\./,
  );
  assert.match(
    email.text,
    /maria VA: 9:00 AM – 5:00 PM your time from Sunday, 4 October 2026 \(6:00 AM – 2:00 PM Manila time/,
  );
  assert.match(email.text, /Best regards,\nAccounts Team$/);
  assert.doesNotMatch(email.html, /do not reply/);
});

test("a client with daylight saving switched off is not emailed", () => {
  const plans = planClientDstEmails(
    [company("nsw", "NSW", { clientEmailTopics: { daylightSaving: false } })],
    [va("maria", ["nsw"])],
    new Date("2026-09-29T00:00:00Z"),
  );
  assert.equal(plans.length, 0);
});

test("one click emails the client and each VA whose own hours move", async () => {
  const posts: { event: string; to: string; subject: string; text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, ...body.email });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const plans = planClientDstEmails(
    [company("nsw", "NSW")],
    [
      va("maria", ["nsw"]),
      // Lives in Sydney too, so her own clock moves with the client's: nothing to tell.
      va("syd", ["nsw"], { country: "AU", timezone: "Australia/Sydney" }),
    ],
    new Date("2026-09-29T00:00:00Z"),
  );
  const result = await sendClientDstEmails({ plans, fetchImpl });
  assert.deepEqual(result, { sent: 1, failed: 0, vas: 1 });
  const notice = posts.find((post) => post.event === "dst_va_notice")!;
  assert.equal(notice.to, "maria@example.com");
  assert.equal(notice.subject, "Your working hours change on Sunday, 4 October 2026");
  assert.match(notice.text, /^Hi maria,/);
  assert.match(
    notice.text,
    /From Sunday, 4 October 2026: 6:00 AM – 2:00 PM Manila time \(before: 7:00 AM – 3:00 PM Manila time\)/,
  );
});

test("a California client is told when its own clocks change, and Arizona never is", () => {
  const plans = planClientDstEmails(
    [company("cal", "US-CA"), company("ari", "US-AZ")],
    [va("maria", ["cal"], { shiftTimezone: "America/Los_Angeles" }), va("jo", ["ari"])],
    new Date("2026-10-20T00:00:00Z"),
  );
  assert.deepEqual(
    plans.map((plan) => plan.company.id),
    ["cal"],
  );
  assert.equal(plans[0].change.date, "2026-11-01");
  assert.equal(plans[0].change.kind, "end");
  assert.match(
    buildClientDstEmail(plans[0]).text,
    /Daylight Saving Time ends in California on Sunday, 1 November 2026/,
  );
});
