import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/use-navigation-badge-counts.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function subscriptions(isAdmin: boolean, employee: unknown) {
  const queries: any[] = [];
  const cleanups: (() => void)[] = [];
  let stopped = 0;
  let lateEnabled = false;
  const dependencies: Record<string, unknown> = {
    react: {
      useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
      useMemo: (fn: () => unknown) => fn(),
      useEffect: (fn: () => (() => void)) => { cleanups.push(fn()); },
    },
    "firebase/firestore": {
      collection: (_db: unknown, name: string) => name,
      where: (field: string, op: string, value: unknown) => ({ field, op, value }),
      query: (collection: string, ...constraints: unknown[]) => ({ collection, constraints }),
      onSnapshot: (query: unknown) => { queries.push(query); return () => stopped++; },
    },
    "./firebase": { db: () => ({}) },
    "./types": { COMPANY_ID: "default" },
    "./use-admin-late-notification-count": { useAdminLateNotificationCount: ({ enabled }: { enabled: boolean }) => { lateEnabled = enabled; return 0; } },
  };
  const exports: any = {};
  const window = { addEventListener() {}, removeEventListener() {} };
  new Function("require", "exports", "window", compiled)((name: string) => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  }, exports, window);
  exports.useNavigationBadgeCounts({ isAdmin, employee, company: null, activeCompanyId: "default" });
  for (const cleanup of cleanups) cleanup();
  assert.equal(stopped, queries.length);
  return { queries, lateEnabled };
}

test("employee navigation subscribes only to their leave requests, including legacy login ID", () => {
  const result = subscriptions(false, { id: "rose-profile", authUid: "rose-login" });
  assert.equal(result.lateEnabled, false);
  assert.deepEqual(result.queries, [{ collection: "leaveRequests", constraints: [{ field: "employeeId", op: "in", value: ["rose-profile", "rose-login"] }] }]);
});

test("admin navigation loads pending approvals instead of complete request history", () => {
  const result = subscriptions(true, { id: "admin" });
  assert.equal(result.lateEnabled, true);
  assert.deepEqual(result.queries.map((q) => q.collection), ["overtimeRequests", "leaveRequests"]);
  for (const query of result.queries) assert.deepEqual(query.constraints, [{ field: "status", op: "==", value: "pending" }]);
});

test("unassigned user does not subscribe to company-wide notification data", () => {
  assert.deepEqual(subscriptions(false, null), { queries: [], lateEnabled: false });
});
