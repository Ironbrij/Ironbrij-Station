import test from "node:test";
import assert from "node:assert/strict";
import { sendHolidayEmails } from "../src/lib/holiday-email.ts";
import { sharedCalendar } from "../src/lib/holidays.ts";
import { COMPANY_ID, type Company, type Employee } from "../src/lib/types.ts";

const companies = [
  {
    id: COMPANY_ID,
    name: "Main",
    isMain: true,
    defaultShiftHours: 8,
    workingDays: [1],
    holidays: [],
    holidayAssignments: [
      {
        id: "nsw-labour",
        date: "2026-10-05",
        name: "Labour Day",
        targetType: "states",
        stateCodes: ["NSW"],
      },
    ],
  },
  {
    id: "alpha",
    name: "Alpha",
    state: "NSW",
    defaultShiftHours: 8,
    workingDays: [1],
    holidays: [],
  },
  { id: "beta", name: "Beta", state: "VIC", defaultShiftHours: 8, workingDays: [1], holidays: [] },
] as Company[];

const person = (id: string, email: string, companyIds: string[], status = "active") =>
  ({
    id,
    name: `${id} Person`,
    email,
    companyId: companyIds[0],
    companyIds,
    status,
    inviteStatus: "accepted",
  }) as Employee;

test("each person given the holiday gets their own email through the webhook", async () => {
  const calls: { to: string; subject: string; text: string; event: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({
      to: body.email.to,
      subject: body.email.subject,
      text: body.email.text,
      event: body.event,
    });
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
  assert.deepEqual(result, { ok: true, sent: 1, failed: 0, clients: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "maria@example.com");
  assert.equal(calls[0].event, "holiday_notice");
  assert.equal(calls[0].subject, "Upcoming public holiday: Labour Day, Monday, 5 October 2026");
  assert.match(
    calls[0].text,
    /You have an upcoming public holiday on Monday, 5 October 2026 for Labour Day./,
  );
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

test("each client with people off is asked whether their VA will work the holiday", async () => {
  const posts: { event: string; to: string; subject: string; text: string; html: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, ...body.email });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const withClients = companies.map((company) =>
    company.id === "alpha"
      ? { ...company, clientEmails: ["boss@alpha.com", "ops@alpha.com"] }
      : company.id === "beta"
        ? { ...company, clientEmails: ["boss@beta.com"] }
        : company,
  );
  const result = await sendHolidayEmails({
    holidays: sharedCalendar(withClients)!.holidayAssignments!,
    employees: [
      person("maria", "maria@example.com", ["alpha", "beta"]),
      person("ram", "ram@example.com", ["alpha"]),
    ],
    companies: withClients,
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  assert.equal(result.ok && result.clients, 1);
  const client = posts.filter((post) => post.event === "holiday_client_notice");
  // NSW Labour Day closes Alpha only; Beta (VIC) keeps working and is not told.
  assert.equal(client.length, 1);
  assert.equal(client[0].to, "boss@alpha.com,ops@alpha.com");
  assert.equal(client[0].subject, "Upcoming public holiday: Labour Day, Monday, 5 October 2026");
  assert.equal(
    client[0].text,
    [
      "Dear Alpha,",
      "",
      "I hope this email finds you well. As Labour Day approaches in New South Wales, on Monday, 5 October 2026, I wanted to remind you of this upcoming holiday.",
      "",
      "If you would like your Virtual Assistant to work on Monday, 5 October 2026, we'd be happy to accommodate this. Please note that any hours worked on this day will be considered paid overtime and will be included in your next invoice.",
      "",
      "To ensure accurate billing in the next cycle, kindly let us know if you'd like your VA to work on this day.",
      "",
      "Thank you for your understanding. Should you have any questions or need further assistance, please feel free to reach out.",
      "",
      "Best regards,",
      "Accounts Team",
    ].join("\n"),
  );
  // The client is asked to answer, so the footer must not tell them not to reply.
  assert.doesNotMatch(client[0].html, /do not reply/);
  assert.match(client[0].html, /Accounts Team/);
});

test("a client with no state set is still asked, without naming a state", async () => {
  const posts: { event: string; text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, text: body.email.text });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const gamma = {
    id: "gamma",
    name: "Gamma",
    defaultShiftHours: 8,
    workingDays: [1],
    holidays: [],
    clientEmails: ["boss@gamma.com"],
  } as Company;
  const result = await sendHolidayEmails({
    holidays: [{ id: "xmas", date: "2026-12-25", name: "Christmas Day", targetType: "all" }],
    employees: [person("ram", "ram@example.com", ["gamma"])],
    companies: [gamma],
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  assert.equal(result.ok && result.clients, 1);
  const client = posts.find((post) => post.event === "holiday_client_notice")!;
  assert.match(client.text, /As Christmas Day approaches on Friday, 25 December 2026, I wanted/);
});

test("someone not entitled to public holidays gets no holiday email, and their client is not asked", async () => {
  const posts: { event: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    posts.push({ event: JSON.parse(String(init.body)).event });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const withClient = companies.map((company) =>
    company.id === "alpha" ? { ...company, clientEmails: ["boss@alpha.com"] } : company,
  );
  const result = await sendHolidayEmails({
    holidays: sharedCalendar(withClient)!.holidayAssignments!,
    employees: [{ ...person("ram", "ram@example.com", ["alpha"]), noPublicHolidays: true }],
    companies: withClient,
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: 0, failed: 0, clients: 0 });
  assert.equal(posts.length, 0);
});

test("the client email carries Work on Holiday and Do Not Work links, saved per client and holiday", async () => {
  const posts: { event: string; text: string; html: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, text: body.email.text, html: body.email.html });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const saved: { company: string; holiday: string; vas: string[] }[] = [];
  const withClient = companies.map((company) =>
    company.id === "alpha" ? { ...company, clientEmails: ["boss@alpha.com"] } : company,
  );
  await sendHolidayEmails({
    holidays: sharedCalendar(withClient)!.holidayAssignments!,
    employees: [person("ram", "ram@example.com", ["alpha"])],
    companies: withClient,
    departments: [],
    appUrl: "https://example.com",
    saveClientQuestion: async (company, holiday, vas) => {
      saved.push({ company: company.id!, holiday: holiday.id, vas: vas.map((va) => va.email) });
      return "a".repeat(40);
    },
    fetchImpl,
  });
  assert.deepEqual(saved, [{ company: "alpha", holiday: "nsw-labour", vas: ["ram@example.com"] }]);
  const client = posts.find((post) => post.event === "holiday_client_notice")!;
  const token = "a".repeat(40);
  assert.ok(
    client.text.includes(
      `Work on holiday: https://example.com/holiday-response/${token}?choice=work`,
    ),
  );
  assert.ok(
    client.text.includes(`Do not work: https://example.com/holiday-response/${token}?choice=off`),
  );
  assert.match(client.text, /by choosing one option below\./);
  assert.match(client.html, />Work on Holiday</);
  assert.match(client.html, />Do Not Work</);
});

test("a client whose answer link could not be saved is asked to reply instead", async () => {
  const posts: { event: string; text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, text: body.email.text });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const withClient = companies.map((company) =>
    company.id === "alpha" ? { ...company, clientEmails: ["boss@alpha.com"] } : company,
  );
  const result = await sendHolidayEmails({
    holidays: sharedCalendar(withClient)!.holidayAssignments!,
    employees: [person("ram", "ram@example.com", ["alpha"])],
    companies: withClient,
    departments: [],
    appUrl: "https://example.com",
    saveClientQuestion: async () => {
      throw new Error("Firestore is down");
    },
    fetchImpl,
  });
  assert.equal(result.ok && result.clients, 1);
  const client = posts.find((post) => post.event === "holiday_client_notice")!;
  assert.doesNotMatch(client.text, /holiday-response/);
  assert.match(client.text, /kindly let us know if you'd like your VA to work on this day\./);
});

test("the VA's holiday email says their client will decide, when their client is asked", async () => {
  const posts: { event: string; to: string; text: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    posts.push({ event: body.event, to: body.email.to, text: body.email.text });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const withClient = companies.map((company) =>
    company.id === "alpha" ? { ...company, clientEmails: ["boss@alpha.com"] } : company,
  );
  await sendHolidayEmails({
    holidays: sharedCalendar(withClient)!.holidayAssignments!,
    employees: [{ ...person("ann", "ann@example.com", ["alpha"]), name: "Ann Cataring" }],
    companies: withClient,
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  const va = posts.find((post) => post.event === "holiday_notice")!;
  assert.equal(
    va.text,
    [
      "You Have an Upcoming Public Holiday",
      "",
      "Hi Ann,",
      "",
      "You have an upcoming public holiday on Monday, 5 October 2026 for Labour Day.",
      "",
      "Upcoming Public Holiday: Labour Day, Monday, 5 October 2026",
      "",
      "This is a reminder about your upcoming public holiday. Your client will let us know if they would like you to work on this holiday. The system or Accounts Team will notify you once their decision is confirmed.",
      "",
      "If your client requests you to work, please log in and work your usual hours. If they do not request you to work, please do not punch in.",
      "",
      "Best regards,",
      "Accounts Team",
    ].join("\n"),
  );

  // No client email saved for Alpha: nobody will decide, so they are simply off.
  posts.length = 0;
  await sendHolidayEmails({
    holidays: sharedCalendar(companies)!.holidayAssignments!,
    employees: [{ ...person("ann", "ann@example.com", ["alpha"]), name: "Ann Cataring" }],
    companies,
    departments: [],
    appUrl: "https://example.com",
    fetchImpl,
  });
  assert.match(
    posts[0].text,
    /This is a reminder about your upcoming public holiday\. Please do not punch in on this day\./,
  );
  assert.doesNotMatch(posts[0].text, /Your client will let us know/);
});
