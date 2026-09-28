import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDecisionNoticeEmail,
  buildVaWorkEmail,
  isResponseToken,
  newHolidayResponse,
  newResponseToken,
} from "../src/lib/holiday-response.ts";
import type { Company } from "../src/lib/types.ts";

const response = newHolidayResponse({
  company: { id: "alpha", name: "Alpha Pty Ltd" } as Company,
  holiday: { id: "nsw-labour", name: "Labour Day", date: "2026-10-05" },
  vas: [{ id: "ram", name: "Ram Thapa", email: "ram@example.com" }],
  notifyEmail: "ann@example.com",
  now: new Date("2026-09-29T00:00:00Z"),
});

test("tokens are long and random, and only their own shape is accepted", () => {
  const token = newResponseToken();
  assert.ok(isResponseToken(token));
  assert.notEqual(token, newResponseToken());
  assert.equal(isResponseToken("../employees/x"), false);
});

test("a new question waits for the client's answer", () => {
  assert.equal(response.decision, null);
  assert.equal(response.companyName, "Alpha Pty Ltd");
});

test("the VA is told the holiday applies but their client asked them to work", () => {
  const email = buildVaWorkEmail(response, response.vas[0]);
  assert.equal(email.subject, "Please work on Labour Day, Monday, 5 October 2026");
  assert.match(email.text, /^Hi Ram,/);
  assert.match(
    email.text,
    /Labour Day on Monday, 5 October 2026 is a holiday, but Alpha Pty Ltd has asked you to work that day\./,
  );
});

test("the office hears each answer, for billing", () => {
  const work = buildDecisionNoticeEmail(response, "work");
  assert.equal(work.subject, "Alpha Pty Ltd: VA will work on Labour Day, Monday, 5 October 2026");
  assert.match(work.text, /paid overtime for the next invoice/);
  const off = buildDecisionNoticeEmail(response, "off");
  assert.match(off.text, /confirmed Ram Thapa will take Labour Day, Monday, 5 October 2026 off/);
});
