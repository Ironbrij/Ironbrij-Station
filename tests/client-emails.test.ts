import test from "node:test";
import assert from "node:assert/strict";
import { clientEmailsFor, companyClientEmails, parseClientEmails } from "../src/lib/client-emails.ts";

test("a company set up before Client email keeps its weekly report addresses", () => {
  assert.deepEqual(companyClientEmails({ weeklyReportRecipients: ["A@x.com"] }), ["a@x.com"]);
  assert.deepEqual(
    companyClientEmails({ clientEmails: ["new@x.com"], weeklyReportRecipients: ["old@x.com"] }),
    ["new@x.com"],
  );
});

test("every email is on until switched off", () => {
  const company = { clientEmails: ["c@x.com"], clientEmailTopics: { holidays: false } };
  assert.deepEqual(clientEmailsFor(company, "weeklyReport"), ["c@x.com"]);
  assert.deepEqual(clientEmailsFor(company, "holidays"), []);
  assert.deepEqual(clientEmailsFor(company, "leave"), ["c@x.com"]);
});

test("typed addresses are split, cleaned and checked", () => {
  assert.deepEqual(parseClientEmails("a@x.com; B@x.com  not-an-email, a@x.com"), ["a@x.com", "b@x.com"]);
});
