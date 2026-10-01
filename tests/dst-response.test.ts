import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDstDecisionNoticeEmail,
  buildVaDstDecisionEmail,
  type DstResponse,
} from "../src/lib/dst-response.ts";

const response: DstResponse = {
  companyId: "ironbrij",
  companyName: "Ironbrij",
  company: { id: "ironbrij", name: "Ironbrij" },
  change: { date: "2026-10-04", kind: "start", timezone: "Australia/Sydney", minutes: 60 },
  keepLabel: "Keep current PHT schedule",
  lines: [
    {
      id: "ann",
      name: "Ann Cataring",
      email: "ann@example.com",
      clientBefore: "9:00 AM – 5:00 PM",
      clientAfter: "9:00 AM – 5:00 PM",
      vaBefore: "7:00 AM – 3:00 PM",
      vaAfter: "6:00 AM – 2:00 PM",
      vaZone: "PHT",
      clientKeep: "10:00 AM – 6:00 PM",
    },
  ],
  notifyEmail: "office@example.com",
  decision: null,
  createdAt: "2026-09-29T00:00:00.000Z",
};

test("following the client's new schedule moves the VA's own hours", () => {
  const email = buildVaDstDecisionEmail(response, response.lines, "follow");
  assert.equal(email.subject, "Your working hours for Ironbrij from Sunday, 4 October 2026");
  assert.match(email.text, /^Your Working Hours from Sunday, 4 October 2026\n\nHi Ann,/);
  assert.match(email.text, /Your hours: 6:00 AM – 2:00 PM PHT/);
  assert.match(email.text, /Client's clock: 9:00 AM – 5:00 PM \(Ironbrij\)/);
  assert.match(email.text, /has chosen for you to follow their new DST schedule\./);
  assert.match(email.text, /Please punch in at your new time\./);
});

test("keeping the current schedule keeps the VA's own hours", () => {
  const email = buildVaDstDecisionEmail(response, response.lines, "keep");
  assert.match(email.text, /Your hours: 7:00 AM – 3:00 PM PHT/);
  assert.match(email.text, /Client's clock: 10:00 AM – 6:00 PM \(Ironbrij\)/);
  assert.match(email.text, /Please keep punching in at your usual time\./);
});

test("the office is told what to change in SavyTime when the VA keeps their hours", () => {
  // Older records, with no saved-shift details: their shifts follow the client.
  const keep = buildDstDecisionNoticeEmail(response, "keep", 1);
  assert.equal(keep.subject, "Ironbrij: VA keeps current schedule from Sunday, 4 October 2026");
  assert.match(keep.text, /^Client Chose: Keep current PHT schedule/);
  assert.match(
    keep.text,
    /Ann Cataring: 10:00 AM – 6:00 PM on Ironbrij's clock \(was 9:00 AM – 5:00 PM\)/,
  );
  assert.match(keep.text, /The VA has been notified by email\.$/);

  const follow = buildDstDecisionNoticeEmail(response, "follow", 0);
  assert.match(follow.text, /Nothing needs to change in SavyTime/);
  assert.match(follow.text, /The VA has not been emailed/);
});

test("the office gets the exact saved times to set, on the clock the shift is saved on", () => {
  const onSydney = {
    ...response,
    lines: [
      {
        ...response.lines[0],
        savedZone: "Sydney time",
        automatic: "follow" as const,
        savedFollow: "9:00 AM – 5:00 PM",
        savedKeep: "10:00 AM – 6:00 PM",
      },
    ],
  };
  assert.match(
    buildDstDecisionNoticeEmail(onSydney, "keep", 1).text,
    /Ann Cataring: Set to 10:00 AM – 6:00 PM Sydney time \(10:00 AM – 6:00 PM on Ironbrij's clock\)/,
  );
  assert.match(buildDstDecisionNoticeEmail(onSydney, "follow", 1).text, /Nothing needs to change/);

  // Saved on Manila time, the shift keeps PHT by itself; following Sydney needs a change.
  const onManila = {
    ...response,
    lines: [
      {
        ...response.lines[0],
        savedZone: "Manila time",
        automatic: "keep" as const,
        savedFollow: "6:00 AM – 2:00 PM",
        savedKeep: "7:00 AM – 3:00 PM",
      },
    ],
  };
  assert.match(buildDstDecisionNoticeEmail(onManila, "keep", 1).text, /Nothing needs to change/);
  assert.match(
    buildDstDecisionNoticeEmail(onManila, "follow", 1).text,
    /Ann Cataring: Set to 6:00 AM – 2:00 PM Manila time \(9:00 AM – 5:00 PM on Ironbrij's clock\)/,
  );
});
