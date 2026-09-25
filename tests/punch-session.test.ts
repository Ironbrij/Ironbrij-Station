import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAutoClose,
  applyEmployeePunch,
  isAttendanceConflict,
  latestShiftBoundary,
  overtimeRequestId,
  readSessionContext,
  sessionCloseId,
  type DocTx,
  type EmployeePunchPlan,
} from "../src/lib/punch-session.ts";
import type { Punch } from "../src/lib/types.ts";

type Data = Record<string, unknown>;

/**
 * Firestore's transaction contract, in memory: reads record a version, and a
 * commit whose reads went stale is thrown away and the transaction run again.
 */
function memoryDb(initial: Record<string, Data> = {}) {
  const docs = new Map<string, { data: Data; version: number }>();
  for (const [path, data] of Object.entries(initial)) docs.set(path, { data, version: 1 });
  let commits = 0;

  async function run<T>(body: (tx: DocTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reads = new Map<string, number>();
      const writes: { path: string; data: Data; merge: boolean }[] = [];
      const tx: DocTx = {
        async get(path) {
          // Yield, so two transactions started together really interleave.
          await new Promise((resolve) => setImmediate(resolve));
          const current = docs.get(path);
          reads.set(path, current?.version ?? 0);
          return current ? structuredClone(current.data) : undefined;
        },
        set(path, data) {
          writes.push({ path, data, merge: false });
        },
        update(path, data) {
          if (!docs.has(path) && !writes.some((write) => write.path === path)) {
            throw new Error(`No document to update: ${path}`);
          }
          writes.push({ path, data, merge: true });
        },
      };
      const result = await body(tx);
      await new Promise((resolve) => setImmediate(resolve));
      const stale = [...reads].some(
        ([path, version]) => (docs.get(path)?.version ?? 0) !== version,
      );
      if (stale) continue;
      for (const write of writes) {
        const current = docs.get(write.path);
        const data = write.merge ? { ...(current?.data ?? {}), ...write.data } : write.data;
        docs.set(write.path, { data, version: (current?.version ?? 0) + 1 });
      }
      commits += 1;
      return result;
    }
    throw new Error("Transaction kept conflicting");
  }

  return {
    run,
    get: (path: string) => docs.get(path)?.data,
    paths: (prefix: string) => [...docs.keys()].filter((path) => path.startsWith(prefix)),
    commits: () => commits,
  };
}

const stamp = "2026-09-10T08:00:00.000Z";
const inPunch = (company: string, extra: Data = {}) => ({
  employeeId: "emp",
  companyId: company,
  type: "in",
  timestamp: Date.parse("2026-09-10T00:00:00Z"),
  ...extra,
});
const closePunch = (company: string, extra: Data = {}) => ({
  employeeId: "emp",
  companyId: company,
  type: "out",
  timestamp: Date.parse("2026-09-09T09:00:00Z"),
  ...extra,
});

function start(punchId: string, extra: Partial<EmployeePunchPlan> = {}): EmployeePunchPlan {
  return {
    punchId,
    punch: { employeeId: "emp", companyId: "alpha", type: "in", timestamp: stamp },
    stamp,
    ...extra,
  };
}

async function settle<T>(promises: Promise<T>[]) {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.filter((result) => result.status === "fulfilled").length,
    conflicts: results.filter(
      (result) => result.status === "rejected" && isAttendanceConflict(result.reason),
    ).length,
    other: results.filter(
      (result) => result.status === "rejected" && !isAttendanceConflict(result.reason),
    ),
  };
}

test("two devices pressing Start Work together record one clock-in", async () => {
  const db = memoryDb({ "punches/last-out": closePunch("alpha") });
  const phone = db.run((tx) =>
    applyEmployeePunch(tx, start("from-phone", { followsPunchId: "last-out" })),
  );
  const laptop = db.run((tx) =>
    applyEmployeePunch(tx, start("from-laptop", { followsPunchId: "last-out" })),
  );
  const outcome = await settle([phone, laptop]);

  assert.equal(outcome.ok, 1);
  assert.equal(outcome.conflicts, 1);
  assert.deepEqual(outcome.other, []);
  const ins = db.paths("punches/from-");
  assert.equal(ins.length, 1, "exactly one clock-in was saved");
  assert.equal(db.get("punches/last-out")?.nextPunchInId, ins[0].replace("punches/", ""));
});

test("pressing Start Work again after it succeeded is turned away", async () => {
  const db = memoryDb({ "punches/last-out": closePunch("alpha") });
  await db.run((tx) => applyEmployeePunch(tx, start("first", { followsPunchId: "last-out" })));
  await assert.rejects(
    db.run((tx) => applyEmployeePunch(tx, start("second", { followsPunchId: "last-out" }))),
    isAttendanceConflict,
  );
  // Retrying the same punch (a network retry of one click) is harmless.
  await db.run((tx) => applyEmployeePunch(tx, start("first", { followsPunchId: "last-out" })));
  assert.deepEqual(db.paths("punches/"), ["punches/last-out", "punches/first"]);
});

test("Stop Work racing automatic punch-out closes the shift once", async () => {
  const db = memoryDb({ "punches/shift": inPunch("alpha") });
  const employee = db.run((tx) =>
    applyEmployeePunch(tx, {
      punchId: "manual-out",
      punch: { employeeId: "emp", companyId: "alpha", type: "out", timestamp: stamp },
      sessionInId: "shift",
      stamp,
    }),
  );
  const automatic = db.run((tx) =>
    applyAutoClose(
      tx,
      {
        sessionInId: "shift",
        expected: { timestampMs: Date.parse("2026-09-10T00:00:00Z") },
        close: { employeeId: "emp", companyId: "alpha", type: "out", isAuto: true },
        stamp,
      },
      (value) => Number(value),
    ),
  );
  const [manual, auto] = await Promise.allSettled([employee, automatic]);

  const closes = db.paths("punches/").filter((path) => path !== "punches/shift");
  assert.equal(closes.length, 1, "one clock-out, never two");
  const closedBy = db.get("punches/shift")?.closedByPunchId;
  if (closedBy === "manual-out") {
    assert.equal(auto.status === "fulfilled" && auto.value, false);
  } else {
    assert.equal(closedBy, sessionCloseId("shift"));
    assert.ok(manual.status === "rejected" && isAttendanceConflict(manual.reason));
  }
});

test("ending a shift that was already closed says so instead of stacking a clock-out", async () => {
  const db = memoryDb({ "punches/shift": inPunch("alpha", { closedByPunchId: "auto" }) });
  await assert.rejects(
    db.run((tx) =>
      applyEmployeePunch(tx, {
        punchId: "late-out",
        punch: { employeeId: "emp", type: "out", timestamp: stamp },
        sessionInId: "shift",
        stamp,
      }),
    ),
    /already ended/,
  );
  assert.equal(db.get("punches/late-out"), undefined);
});

test("a shift started before these marks existed can still be ended", async () => {
  const db = memoryDb({ "punches/legacy": inPunch("alpha") });
  await db.run((tx) =>
    applyEmployeePunch(tx, {
      punchId: "b1",
      punch: { employeeId: "emp", type: "lunch_end", timestamp: stamp },
      sessionInId: "legacy",
      stamp,
    }),
  );
  await db.run((tx) =>
    applyEmployeePunch(tx, {
      punchId: "out",
      punch: { employeeId: "emp", type: "out", timestamp: stamp },
      sessionInId: "legacy",
      stamp,
    }),
  );
  assert.equal(db.get("punches/legacy")?.closedByPunchId, "out");
  assert.equal(db.get("punches/out")?.punchInId, "legacy");
});

test("a break cannot be started twice or ended twice", async () => {
  const db = memoryDb({ "punches/shift": inPunch("alpha") });
  const breakStart = (id: string) =>
    db.run((tx) =>
      applyEmployeePunch(tx, {
        punchId: id,
        punch: { employeeId: "emp", type: "lunch_start", timestamp: stamp },
        sessionInId: "shift",
        stamp,
      }),
    );
  const breakEnd = (id: string) =>
    db.run((tx) =>
      applyEmployeePunch(tx, {
        punchId: id,
        punch: { employeeId: "emp", type: "lunch_end", timestamp: stamp },
        sessionInId: "shift",
        stamp,
      }),
    );
  const outcome = await settle([breakStart("b-phone"), breakStart("b-laptop")]);
  assert.equal(outcome.ok, 1);
  assert.equal(outcome.conflicts, 1);
  await breakEnd("e1");
  await assert.rejects(breakEnd("e2"), /already ended/);
  assert.equal(db.get("punches/shift")?.breakPunchId, null);
});

test("switching client on two devices closes the old shift once and starts one new one", async () => {
  const db = memoryDb({ "punches/alpha-shift": inPunch("alpha") });
  const switchTo = (id: string) =>
    db.run((tx) =>
      applyEmployeePunch(tx, {
        ...start(id),
        punch: { employeeId: "emp", companyId: "beta", type: "in", timestamp: stamp },
        switchFrom: {
          inId: "alpha-shift",
          close: {
            employeeId: "emp",
            companyId: "alpha",
            type: "out",
            isAuto: true,
            autoReason: "switch_company",
          },
        },
      }),
    );
  const outcome = await settle([switchTo("beta-phone"), switchTo("beta-laptop")]);
  assert.equal(outcome.ok, 1);
  assert.equal(outcome.conflicts, 1);
  assert.equal(db.paths("punches/beta-").length, 1);
  const close = db.get(`punches/${sessionCloseId("alpha-shift")}`);
  assert.equal(close?.autoReason, "switch_company");
  assert.equal(close?.punchInId, "alpha-shift");
  assert.equal(db.get("punches/alpha-shift")?.closedByPunchId, sessionCloseId("alpha-shift"));
});

test("switching after automatic punch-out already closed the old shift adds no second close", async () => {
  const closeId = sessionCloseId("alpha-shift");
  const db = memoryDb({
    "punches/alpha-shift": inPunch("alpha", { closedByPunchId: closeId }),
    [`punches/${closeId}`]: closePunch("alpha", { isAuto: true }),
  });
  await db.run((tx) =>
    applyEmployeePunch(tx, {
      ...start("beta-in"),
      switchFrom: { inId: "alpha-shift", close: { type: "out", replaced: true } },
    }),
  );
  assert.equal(db.get(`punches/${closeId}`)?.replaced, undefined, "the existing close is kept");
  assert.equal(db.get("punches/alpha-shift")?.nextPunchInId, "beta-in");
});

test("automatic punch-out leaves a shift alone once an admin corrected it", async () => {
  const db = memoryDb({
    "punches/shift": inPunch("alpha", { correctedAt: "2026-09-10T03:00:00Z" }),
  });
  const created = await db.run((tx) =>
    applyAutoClose(
      tx,
      {
        sessionInId: "shift",
        expected: { timestampMs: Date.parse("2026-09-10T00:00:00Z") },
        close: { type: "out" },
        stamp,
      },
      (value) => Number(value),
    ),
  );
  assert.equal(created, false);
  assert.equal(db.get(`punches/${sessionCloseId("shift")}`), undefined);
});

test("overtime from one punch is filed once, and a pending one follows the session", async () => {
  const db = memoryDb({ "punches/ot-shift": inPunch("alpha", { type: "extra_in" }) });
  const extraId = overtimeRequestId("extra", "ot-shift");
  // The request filed when overtime started has no minutes yet.
  await db.run(async (tx) => {
    tx.set(`overtimeRequests/${extraId}`, { status: "pending", overtimeMinutes: 0 });
  });
  const end = (punchId: string) =>
    db.run((tx) =>
      applyEmployeePunch(tx, {
        punchId,
        punch: { employeeId: "emp", type: "extra_out", timestamp: stamp },
        sessionInId: "ot-shift",
        stamp,
        overtime: [
          {
            id: extraId,
            data: { status: "pending", overtimeMinutes: 95, punchOutId: punchId },
            mode: "pending",
            fallbackId: overtimeRequestId("out", punchId),
          },
        ],
      }),
    );
  await end("ot-out");
  assert.equal(db.get(`overtimeRequests/${extraId}`)?.overtimeMinutes, 95);
  assert.equal(db.paths("overtimeRequests/").length, 1, "no second request for the same session");
});

test("a decided overtime request is never reopened by a later punch", async () => {
  const extraId = overtimeRequestId("extra", "ot-shift");
  const db = memoryDb({
    "punches/ot-shift": inPunch("alpha", { type: "extra_in" }),
    [`overtimeRequests/${extraId}`]: { status: "rejected", overtimeMinutes: 0 },
  });
  await db.run((tx) =>
    applyEmployeePunch(tx, {
      punchId: "ot-out",
      punch: { employeeId: "emp", type: "extra_out", timestamp: stamp },
      sessionInId: "ot-shift",
      stamp,
      overtime: [
        {
          id: extraId,
          data: { status: "pending", overtimeMinutes: 30 },
          mode: "pending",
          fallbackId: overtimeRequestId("out", "ot-out"),
        },
      ],
    }),
  );
  assert.equal(db.get(`overtimeRequests/${extraId}`)?.status, "rejected");
  assert.equal(
    db.get(`overtimeRequests/${overtimeRequestId("out", "ot-out")}`)?.overtimeMinutes,
    30,
  );
});

test("the device's view of open shifts and the last close follows the punches", () => {
  const at = (iso: string) => new Date(iso);
  const punches = [
    { id: "a-in", type: "in", companyId: "alpha", timestamp: at("2026-09-09T01:00:00Z") },
    { id: "a-out", type: "out", companyId: "alpha", timestamp: at("2026-09-09T09:00:00Z") },
    {
      id: "voided",
      type: "out",
      companyId: "beta",
      timestamp: at("2026-09-10T02:00:00Z"),
      voidedAt: "x",
    },
    { id: "b-in", type: "in", companyId: "beta", timestamp: at("2026-09-10T01:00:00Z") },
    {
      id: "b-break",
      type: "lunch_start",
      companyId: "beta",
      timestamp: at("2026-09-10T04:00:00Z"),
    },
  ] as unknown as Punch[];
  const context = readSessionContext(punches, (punch) => punch.companyId || "");
  assert.equal(context.lastClose?.id, "a-out");
  assert.equal(context.open.get("beta")?.in.id, "b-in");
  assert.equal(context.open.get("beta")?.breakPunch?.id, "b-break");
  assert.equal(context.open.has("alpha"), false);
});

test("a new shift follows a forgotten clock-in without closing it", async () => {
  const at = (iso: string) => new Date(iso);
  const punches = [
    { id: "old-out", type: "out", companyId: "alpha", timestamp: at("2026-09-08T09:00:00Z") },
    { id: "forgot", type: "in", companyId: "alpha", timestamp: at("2026-09-09T01:00:00Z") },
  ] as unknown as Punch[];
  const boundary = latestShiftBoundary(
    readSessionContext(punches, (punch) => punch.companyId || ""),
  );
  assert.equal(boundary?.id, "forgot");

  const db = memoryDb({ "punches/forgot": inPunch("alpha") });
  await db.run((tx) => applyEmployeePunch(tx, start("today", { followsPunchId: "forgot" })));
  assert.equal(db.get("punches/forgot")?.nextPunchInId, "today");
  assert.equal(db.get("punches/forgot")?.closedByPunchId, undefined, "left for an admin to fix");
  await assert.rejects(
    db.run((tx) => applyEmployeePunch(tx, start("again", { followsPunchId: "forgot" }))),
    isAttendanceConflict,
  );
});
