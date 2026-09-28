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
  const email = buildVaWorkEmail(
    { ...response, companyName: "Ironbrij" },
    { name: "Ann Cataring" },
  );
  assert.equal(email.subject, "Please work on Labour Day, Monday, 5 October 2026");
  assert.equal(
    email.text,
    [
      "Your Client Asked You to Work",
      "",
      "Hi Ann,",
      "",
      "Labour Day · Monday, 5 October 2026",
      "",
      "Holiday: Labour Day, Monday, 5 October 2026",
      "Client: Ironbrij",
      "Client’s Response: Please work on this day",
      "",
      "Labour Day is a holiday, but Ironbrij has requested that you work on this day.",
      "",
      "Please work your usual hours and punch in as normal. The hours worked will be recorded as holiday work and paid as overtime.",
      "",
      "If you are unable to work on this day, please let us know as soon as possible.",
      "",
      "Best regards,",
      "Accounts Team",
    ].join("\n"),
  );
  assert.match(email.html, /Your Client Asked You to Work/);
  assert.match(email.html, /Client’s Response/);
});

test("the office hears each answer, for billing", () => {
  const work = buildDecisionNoticeEmail(
    { ...response, vas: [{ id: "ann", name: "Ann Cataring", email: "ann@example.com" }] },
    "work",
    1,
  );
  assert.equal(work.subject, "Alpha Pty Ltd: VA will work on Labour Day, Monday, 5 October 2026");
  assert.equal(
    work.text,
    [
      "VA Will Work on the Holiday",
      "",
      "Alpha Pty Ltd · Labour Day · Monday, 5 October 2026",
      "",
      "Alpha Pty Ltd has requested that Ann Cataring work on Labour Day, Monday, 5 October 2026.",
      "",
      "The hours worked on the holiday will be paid as overtime and included in the next invoice.",
      "",
      "The VA has been notified by email.",
    ].join("\n"),
  );
  assert.match(work.html, /VA Will Work on the Holiday/);

  // No VA could be emailed: the office is asked to tell them, not told it was done.
  const untold = buildDecisionNoticeEmail(response, "work", 0);
  assert.match(untold.text, /The VA has not been emailed, as no email address is saved for them\./);

  const two = buildDecisionNoticeEmail(
    {
      ...response,
      vas: [
        { id: "ann", name: "Ann Cataring", email: "ann@example.com" },
        { id: "ram", name: "Ram Thapa", email: "ram@example.com" },
      ],
    },
    "work",
    2,
  );
  assert.match(two.text, /requested that Ann Cataring and Ram Thapa work/);
  assert.match(two.text, /The VAs have been notified by email\./);

  const off = buildDecisionNoticeEmail(response, "off");
  assert.match(
    off.text,
    /Alpha Pty Ltd has confirmed that Ram Thapa will take Labour Day, Monday, 5 October 2026 off\./,
  );
});
