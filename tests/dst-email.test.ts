import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClientDstEmail,
  companyClockTimezone,
  findDstChange,
  newDstResponse,
  planClientDstEmails,
  planDstSchedule,
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

test("the client is only asked to choose: no VA's hours or clock gaps in the email", () => {
  const [plan] = planClientDstEmails(
    [company("nsw", "NSW")],
    [va("maria", ["nsw"]), va("gone", ["nsw"], { status: "inactive" })],
    new Date("2026-09-29T00:00:00Z"),
  );
  assert.deepEqual(plan.schedules, [
    {
      id: "maria",
      shiftIndex: 0,
      name: "maria VA",
      email: "maria@example.com",
      clientBefore: "9:00 AM – 5:00 PM",
      clientAfter: "9:00 AM – 5:00 PM",
      vaBefore: "7:00 AM – 3:00 PM",
      vaAfter: "6:00 AM – 2:00 PM",
      vaPlace: "Manila",
      vaTimezone: "Asia/Manila",
      vaZone: "PHT",
      // Keeping her Manila hours means an hour later on Sydney's new clock.
      clientKeep: "10:00 AM – 6:00 PM",
      savedZone: "Sydney time",
      // Saved on Sydney time, SavyTime follows Sydney by itself.
      automatic: "follow",
      savedFollow: "9:00 AM – 5:00 PM",
      savedKeep: "10:00 AM – 6:00 PM",
      clientStart: "09:00",
      clientEnd: "17:00",
      vaStart: "07:00",
      vaEnd: "15:00",
    },
  ]);
  const email = buildClientDstEmail(plan, { appUrl: "https://example.com", token: "t".repeat(40) });
  assert.equal(
    email.subject,
    "Daylight Saving Time starts on Sunday, 4 October 2026: please choose your VA's schedule",
  );
  assert.match(email.text, /^Dear NSW,/);
  assert.match(
    email.text,
    /starts in New South Wales on Sunday, 4 October 2026, when clocks move forward by 1 hour\./,
  );
  // Nothing about the VA or their hours: not their name, shift times or the gap to Manila.
  for (const body of [email.text, email.html]) {
    assert.doesNotMatch(body, /maria/);
    assert.doesNotMatch(body, /\d:\d\d [AP]M/);
    assert.doesNotMatch(body, /hours? ahead of/);
    assert.doesNotMatch(body, /<table[^>]*>\s*<tr><th/);
  }
  assert.ok(
    email.text.includes(
      "Follow my new DST schedule: your VA keeps the same hours on your clock, so their own start time moves by 1 hour.",
    ),
  );
  assert.ok(
    email.text.includes(
      "Keep current PHT schedule: your VA keeps the same hours on their own clock, so their hours on your clock move by 1 hour.",
    ),
  );
  assert.ok(
    email.text.includes(
      `Follow my new DST schedule: https://example.com/dst-response/${"t".repeat(40)}?choice=follow`,
    ),
  );
  assert.ok(
    email.text.includes(
      `Keep current PHT schedule: https://example.com/dst-response/${"t".repeat(40)}?choice=keep`,
    ),
  );
  assert.match(email.text, /Best regards,\nAccounts Team$/);
  assert.match(email.html, />Follow my new DST schedule</);
  assert.match(email.html, />Keep current PHT schedule</);
  assert.doesNotMatch(email.html, /do not reply/);

  // Without a saved choice, the client is asked to reply instead.
  const reply = buildClientDstEmail(plan);
  assert.match(reply.text, /Simply reply to this email to let us know which you prefer\./);
  assert.doesNotMatch(reply.text, /dst-response/);
});

// The case from the Accounts Team: a Nepal VA on 8 AM to 2 PM Sydney time.
const nepalVa = (shiftTimezone: string, start: string, end: string) =>
  va("bibek", ["nsw"], {
    country: "NP",
    timezone: "Asia/Kathmandu",
    shiftTimezone,
    shiftStartTime: start,
    shiftEndTime: end,
  });

test("a Nepal VA on 8 AM to 2 PM Sydney time: both choices, worked out from the clocks", () => {
  const [plan] = planClientDstEmails(
    [company("nsw", "NSW")],
    [nepalVa("Australia/Sydney", "08:00", "14:00")],
    new Date("2026-09-29T00:00:00Z"),
  );
  const [line] = plan.schedules;
  assert.equal(line.clientBefore, "8:00 AM – 2:00 PM");
  assert.equal(line.vaBefore, "3:45 AM – 9:45 AM");
  // Follow Sydney: same Sydney hours, an hour earlier in Nepal.
  assert.equal(line.clientAfter, "8:00 AM – 2:00 PM");
  assert.equal(line.vaAfter, "2:45 AM – 8:45 AM");
  // Keep NPT: same Nepal hours, an hour later in Sydney.
  assert.equal(line.clientKeep, "9:00 AM – 3:00 PM");
  assert.equal(line.vaZone, "NPT");
  assert.equal(line.automatic, "follow");
  // Worked out and kept for applying the choice, but never sent to the client.
  const email = buildClientDstEmail(plan);
  assert.doesNotMatch(email.text, /Nepal|3:45|2:45|5 hours 15 minutes/);
  assert.doesNotMatch(email.html, /Nepal|3:45|2:45|5 hours 15 minutes/);
  // The choice is still named by the VA's clock, as the button says.
  assert.match(email.text, /Keep current NPT schedule/);
});

test("the same shift saved on Nepal time gives the same choices, and keeps NPT by itself", () => {
  const [plan] = planClientDstEmails(
    [company("nsw", "NSW")],
    [nepalVa("Asia/Kathmandu", "03:45", "09:45")],
    new Date("2026-09-29T00:00:00Z"),
  );
  const [line] = plan.schedules;
  assert.equal(line.clientBefore, "8:00 AM – 2:00 PM");
  assert.equal(line.vaAfter, "2:45 AM – 8:45 AM");
  assert.equal(line.clientKeep, "9:00 AM – 3:00 PM");
  assert.equal(line.automatic, "keep");
  assert.equal(line.savedZone, "Kathmandu time");
  // To follow Sydney, the saved Nepal times have to move an hour earlier.
  assert.equal(line.savedFollow, "2:45 AM – 8:45 AM");
  assert.equal(line.savedKeep, "3:45 AM – 9:45 AM");
});

test("a UK client's clocks go back on their own date, with the gap to Manila growing", () => {
  const [plan] = planClientDstEmails(
    [company("uk", "GB-ENG")],
    [va("ana", ["uk"], { shiftTimezone: "Europe/London" })],
    new Date("2026-10-05T00:00:00Z"),
  );
  assert.equal(plan.change.date, "2026-10-25");
  assert.equal(plan.change.kind, "end");
  const [line] = plan.schedules;
  assert.equal(line.clientBefore, "9:00 AM – 5:00 PM");
  assert.equal(line.vaBefore, "4:00 PM – 12:00 AM");
  assert.equal(line.vaAfter, "5:00 PM – 1:00 AM");
  assert.equal(line.clientKeep, "8:00 AM – 4:00 PM");
  assert.equal(line.automatic, "follow");
  const email = buildClientDstEmail(plan).text;
  assert.match(email, /Daylight Saving Time ends in England on Sunday, 25 October 2026/);
  assert.doesNotMatch(email, /behind the Philippines|\d:\d\d [AP]M/);
});

test("the year-round schedule lists every client, with or without daylight saving or an email", () => {
  const entries = planDstSchedule(
    [
      company("nsw", "NSW", { clientEmails: [] }),
      company("qld", "QLD"),
      company("uk", "GB-ENG"),
      company("empty", "VIC"),
    ],
    [va("a", ["nsw"]), va("b", ["qld"]), va("c", ["uk"], { shiftTimezone: "Europe/London" })],
    new Date("2026-10-01T00:00:00Z"),
  );
  assert.deepEqual(
    entries.map((entry) => [entry.company.id, entry.change?.date ?? null, entry.to.length]),
    [
      ["nsw", "2026-10-04", 0],
      ["uk", "2026-10-25", 1],
      ["qld", null, 1],
    ],
  );
});

test("the official clock-change dates for every client region", () => {
  const next = (timezone: string, from: string) => {
    const change = findDstChange(timezone, new Date(`${from}T00:00:00Z`), 366);
    return change ? `${change.kind} ${change.date}` : "none";
  };
  const expected: Record<string, string> = {
    "Australia/Sydney": "start 2026-10-04",
    "Australia/Melbourne": "start 2026-10-04",
    "Australia/Adelaide": "start 2026-10-04",
    "Australia/Hobart": "start 2026-10-04",
    "Australia/Brisbane": "none",
    "Australia/Perth": "none",
    "Australia/Darwin": "none",
    "Pacific/Auckland": "end 2027-04-04",
    "Europe/London": "end 2026-10-25",
    "Europe/Berlin": "end 2026-10-25",
    "America/New_York": "end 2026-11-01",
    "America/Toronto": "end 2026-11-01",
    "America/Los_Angeles": "end 2026-11-01",
    "America/Phoenix": "none",
    "Asia/Qatar": "none",
    "Asia/Manila": "none",
    "Asia/Kathmandu": "none",
  };
  for (const [timezone, change] of Object.entries(expected)) {
    assert.equal(next(timezone, "2026-10-01"), change, timezone);
  }
  assert.equal(next("Australia/Sydney", "2026-10-05"), "end 2027-04-04");
  assert.equal(next("Europe/London", "2026-10-26"), "start 2027-03-28");
  assert.equal(next("America/New_York", "2026-11-02"), "start 2027-03-14");
});

test("a client given the choice chooses first; their VAs are only told afterwards", async () => {
  const posts: { event: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posts.push({ event: JSON.parse(String(init.body)).event });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const plans = planClientDstEmails(
    [company("nsw", "NSW")],
    [va("maria", ["nsw"])],
    new Date("2026-09-29T00:00:00Z"),
  );
  const saved: string[] = [];
  const result = await sendClientDstEmails({
    plans,
    appUrl: "https://example.com",
    saveClientQuestion: async (plan) => {
      saved.push(newDstResponse(plan, "ann@example.com").keepLabel);
      return "t".repeat(40);
    },
    fetchImpl,
  });
  assert.deepEqual(saved, ["Keep current PHT schedule"]);
  assert.deepEqual(result, { sent: 1, failed: 0, vas: 0 });
  assert.deepEqual(
    posts.map((post) => post.event),
    ["dst_client_notice"],
  );
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
