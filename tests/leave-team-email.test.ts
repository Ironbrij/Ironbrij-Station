import test from "node:test";
import assert from "node:assert/strict";
import { sendLeaveTeamNotice, sendLeaveTeamNoticeWithKey } from "../src/lib/leave-team-email.ts";
import type { Department, Employee, LeaveRequest } from "../src/lib/types.ts";

function employee(id: string, deptId: string): Employee {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    deptId,
    status: "active",
    inviteStatus: "accepted",
  };
}

const employees = [employee("bibek", "dev"), employee("ann", "dev"), employee("rose", "ops")];
const departments: Department[] = [
  { id: "dev", name: "Development" },
  { id: "ops", name: "Operations" },
];
const leave = {
  id: "l1",
  employeeId: "bibek",
  dateFrom: "2026-10-05",
  dateTo: "2026-10-05",
  reason: "private",
  status: "approved",
} as LeaveRequest;

function recordingFetch(respond: (url: string) => Response = () => new Response("{}")) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (init?.method === "POST")
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return respond(String(url));
  }) as typeof fetch;
  return { posts, fetchImpl };
}

test("an approved leave emails the person's own team without any setup", async () => {
  const { posts, fetchImpl } = recordingFetch();
  const result = await sendLeaveTeamNotice({
    event: "approved",
    leaveRequestId: "l1",
    leave,
    employees,
    departments,
    company: { name: "Ironbrij" },
    appUrl: "https://station.example.com",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: 1, clients: 0 });
  assert.equal(posts.length, 1);
  const email = posts[0].body.email as { to: string; subject: string; text: string };
  assert.equal(email.to, "ann@example.com");
  assert.equal(email.subject, "bibek will be on leave on Mon, 5 Oct 2026");
  assert.doesNotMatch(email.text, /private/);
});

test("a leave that is not approved is never sent to the team", async () => {
  const { posts, fetchImpl } = recordingFetch();
  const result = await sendLeaveTeamNotice({
    event: "approved",
    leaveRequestId: "l1",
    leave: { ...leave, status: "pending" },
    employees,
    departments,
    company: { name: "Ironbrij" },
    appUrl: "https://station.example.com",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(posts.length, 0);
});

test("the MCP path reads people and teams with the server key, then sends", async () => {
  const toDocs = (collection: string, rows: Record<string, string>[]) =>
    new Response(
      JSON.stringify({
        documents: rows.map(({ id, ...fields }) => ({
          name: `projects/p/databases/(default)/documents/${collection}/${id}`,
          fields: Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [key, { stringValue: value }]),
          ),
        })),
      }),
    );
  const { posts, fetchImpl } = recordingFetch((url) => {
    if (url.includes("/employees?")) {
      return toDocs(
        "employees",
        employees.map((e) => ({ ...e }) as unknown as Record<string, string>),
      );
    }
    if (url.includes("/departments?")) {
      return toDocs("departments", departments as unknown as Record<string, string>[]);
    }
    if (url.includes("/companies?")) return toDocs("companies", [{ id: "c1", name: "Ironbrij" }]);
    return new Response("{}");
  });
  const result = await sendLeaveTeamNoticeWithKey({
    baseUrl: "https://firestore.example.com/documents",
    apiKey: "k",
    event: "approved",
    leaveRequestId: "l1",
    leave,
    appUrl: "https://station.example.com",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: 1, clients: 0 });
  assert.equal((posts[0].body.email as { to: string }).to, "ann@example.com");
});

test("the MCP path reports a failed read instead of throwing", async () => {
  const { fetchImpl } = recordingFetch(() => new Response("no", { status: 403 }));
  const result = await sendLeaveTeamNoticeWithKey({
    baseUrl: "https://firestore.example.com/documents",
    apiKey: "k",
    event: "approved",
    leaveRequestId: "l1",
    leave,
    appUrl: "https://station.example.com",
    fetchImpl,
  });
  assert.equal(result.ok, false);
});

test("the client the person works for is told on its own email, without the reason", async () => {
  const { posts, fetchImpl } = recordingFetch();
  const worker = { ...employee("bibek", "dev"), companyId: "alpha", companyIds: ["alpha", "beta"] };
  const result = await sendLeaveTeamNotice({
    event: "approved",
    leaveRequestId: "l1",
    leave: { ...leave, companyId: "alpha" },
    employees: [worker, employee("ann", "dev")],
    departments,
    companies: [
      { id: "alpha", name: "Alpha", clientEmails: ["boss@alpha.com"], defaultShiftHours: 8, workingDays: [1], holidays: [] },
      { id: "beta", name: "Beta", clientEmails: ["boss@beta.com"], defaultShiftHours: 8, workingDays: [1], holidays: [] },
    ],
    company: { name: "Ironbrij" },
    appUrl: "https://station.example.com",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, sent: 1, clients: 1 });
  const client = posts.find((post) => post.body.event === "leave_client_notice")!;
  const email = client.body.email as { to: string; text: string; html: string };
  // The leave was for Alpha, so Beta is not told; nor does Alpha see our team.
  assert.equal(email.to, "boss@alpha.com");
  assert.doesNotMatch(email.text, /private|Development/);
  assert.doesNotMatch(email.html, /ann@example.com/);
});

test("a client that switched leave emails off is not told", async () => {
  const { posts, fetchImpl } = recordingFetch();
  const worker = { ...employee("bibek", "dev"), companyId: "alpha", companyIds: ["alpha"] };
  await sendLeaveTeamNotice({
    event: "approved",
    leaveRequestId: "l1",
    leave,
    employees: [worker],
    departments,
    companies: [
      { id: "alpha", name: "Alpha", clientEmails: ["boss@alpha.com"], clientEmailTopics: { leave: false }, defaultShiftHours: 8, workingDays: [1], holidays: [] },
    ],
    company: { name: "Ironbrij" },
    appUrl: "https://station.example.com",
    fetchImpl,
  });
  assert.equal(posts.length, 0);
});
