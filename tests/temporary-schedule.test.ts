import test from "node:test";
import assert from "node:assert/strict";
import {
  endTemporarySchedule,
  moveTime,
  startTemporarySchedule,
} from "../src/lib/temporary-schedule.ts";
import { sendScheduleChangeEmails } from "../src/lib/schedule-change-email.ts";
import type { Company, Employee } from "../src/lib/types.ts";

const maria = {
  id: "maria",
  name: "Maria Cruz",
  email: "maria@example.com",
  status: "active",
  inviteStatus: "accepted",
  companyId: "nsw",
  companyIds: ["nsw", "qld"],
  timezone: "Asia/Manila",
  shiftTimezone: "Australia/Sydney",
  shiftStartTime: "09:00",
  shiftEndTime: "17:00",
  companyMemberships: {
    nsw: { companyId: "nsw", shiftStartTime: "09:00", shiftEndTime: "17:00", departmentId: "d1" },
    qld: {
      companyId: "qld",
      isMultipleShift: true,
      shifts: [{ startTime: "18:00", endTime: "20:00", workingDays: [1] }],
    },
  },
} as unknown as Employee;

test("times move and wrap past midnight", () => {
  assert.equal(moveTime("09:00", 60), "10:00");
  assert.equal(moveTime("23:30", 60), "00:30");
  assert.equal(moveTime("00:15", -60), "23:15");
});

test("switching on moves only the picked companies, and off puts back exactly what was there", () => {
  const on = startTemporarySchedule(maria, ["nsw"], 60, new Date("2026-10-04T00:00:00Z"));
  assert.equal(on.shiftStartTime, "10:00");
  assert.equal(on.shiftEndTime, "18:00");
  assert.equal(on.companyMemberships!.nsw.shiftStartTime, "10:00");
  assert.equal(on.companyMemberships!.nsw.departmentId, "d1");
  // Queensland has no daylight saving; its evening shift is untouched.
  assert.deepEqual(on.companyMemberships!.qld, maria.companyMemberships!.qld);
  assert.deepEqual(on.temporarySchedule.companyIds, ["nsw"]);

  const saved = { ...maria, ...on } as Employee;
  const off = endTemporarySchedule(saved);
  const back = { ...saved, ...off } as Employee;
  assert.equal(back.shiftStartTime, "09:00");
  assert.equal(back.shiftEndTime, "17:00");
  assert.deepEqual(back.companyMemberships, maria.companyMemberships);
  assert.equal(off.temporarySchedule, null);
});

test("a multi-shift company moves every shift", () => {
  const on = startTemporarySchedule(maria, ["qld"], -60);
  assert.equal(on.companyMemberships!.qld.shifts![0].startTime, "17:00");
  assert.equal(on.companyMemberships!.qld.shifts![0].endTime, "19:00");
  // Not the primary company, so the profile's own times stay.
  assert.equal(on.shiftStartTime, undefined);
});

test("switching on emails the VA and the client with the hours before and after", async () => {
  const posts: { event: string; to: string; subject: string; text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, ...body.email });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const companies = [
    { id: "nsw", name: "Alpha", state: "NSW", clientEmails: ["boss@alpha.com"] },
  ] as unknown as Company[];
  const saved = { ...maria, ...startTemporarySchedule(maria, ["nsw"], 60) } as Employee;
  const result = await sendScheduleChangeEmails({
    employee: saved,
    companies,
    companyIds: ["nsw"],
    minutes: 60,
    started: true,
    now: new Date("2026-10-05T00:00:00Z"),
    fetchImpl,
  });
  assert.deepEqual(result, { va: true, clients: 1, failed: 0 });
  const va = posts.find((post) => post.event === "schedule_change_va")!;
  assert.equal(va.to, "maria@example.com");
  assert.equal(va.subject, "Your working hours change from Monday, 5 October 2026");
  // After Sydney's clocks went forward, 10 to 6 Sydney is 7 to 3 in Manila: her usual hours.
  assert.match(
    va.text,
    /New hours: 7:00 AM – 3:00 PM Manila time \(10:00 AM – 6:00 PM Alpha time\)/,
  );
  assert.match(va.text, /Before: 6:00 AM – 2:00 PM Manila time \(9:00 AM – 5:00 PM Alpha time\)/);
  const client = posts.find((post) => post.event === "schedule_change_client")!;
  assert.equal(client.to, "boss@alpha.com");
  assert.equal(client.subject, "Maria Cruz's working hours change from Monday, 5 October 2026");
  assert.match(
    client.text,
    /New hours: 10:00 AM – 6:00 PM your time\n- Before: 9:00 AM – 5:00 PM your time/,
  );

  posts.length = 0;
  const onlyVa = await sendScheduleChangeEmails({
    employee: saved,
    companies,
    companyIds: ["nsw"],
    minutes: 60,
    started: true,
    emailClients: false,
    fetchImpl,
  });
  assert.deepEqual(onlyVa, { va: true, clients: 0, failed: 0 });
});
