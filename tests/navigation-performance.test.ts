import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/use-navigation-badge-counts.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Reads go through the shared live-data layer, which owns listener lifetimes
// (tests/live-store.test.ts). Here we check what the navigation asks it for.
function subscriptions(isAdmin: boolean, employee: { id: string; authUid?: string } | null) {
  const queries: any[] = [];
  let lateEnabled = false;
  const idle = { data: undefined, status: "loading" };
  const dependencies: Record<string, unknown> = {
    react: {
      useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
      useMemo: (fn: () => unknown) => fn(),
      useEffect: (fn: () => (() => void)) => { fn()?.(); },
    },
    "./live-data": {
      listOf: (state: { data?: unknown[] }) => state.data ?? [],
      useWhereEqualLive: (collection: string, field: string, value: string | null) => {
        if (value !== null) queries.push({ collection, constraints: [{ field, op: "==", value }] });
        return idle;
      },
      useEmployeeLeavesLive: (who: { id: string; authUid?: string } | null) => {
        const ids = who ? [...new Set([who.id, who.authUid].filter(Boolean))] : [];
        if (ids.length) {
          queries.push({ collection: "leaveRequests", constraints: [{ field: "employeeId", ids }] });
        }
        return idle;
      },
    },
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
  return { queries, lateEnabled };
}

test("employee navigation subscribes only to their leave requests, including legacy login ID", () => {
  const result = subscriptions(false, { id: "rose-profile", authUid: "rose-login" });
  assert.equal(result.lateEnabled, false);
  assert.equal(result.queries.length, 1);
  assert.equal(result.queries[0].collection, "leaveRequests");
  assert.deepEqual([...result.queries[0].constraints[0].ids].sort(), ["rose-login", "rose-profile"]);
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
