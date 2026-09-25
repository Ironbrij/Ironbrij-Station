import test from "node:test";
import assert from "node:assert/strict";
import { changedFields } from "../src/lib/stale-check.ts";

const opened = {
  name: "Maria Santos",
  shiftStartTime: "09:00",
  workingDays: [1, 2, 3, 4, 5],
  companyMemberships: { alpha: { status: "active", shiftStartTime: "09:00" } },
  annualLeaveCredits: null,
};

test("nothing changed since the form opened", () => {
  assert.deepEqual(changedFields(opened, { ...opened }, Object.keys(opened)), []);
});

test("another admin's change to a field the form shows is caught", () => {
  const saved = {
    ...opened,
    companyMemberships: { alpha: { status: "active", shiftStartTime: "10:00" } },
  };
  assert.deepEqual(changedFields(opened, saved, Object.keys(opened)), ["companyMemberships"]);
});

test("changes to fields the form does not show do not block it", () => {
  const saved = { ...opened, photoUrl: "https://example.com/new.png", authUid: "login" };
  assert.deepEqual(changedFields(opened, saved, ["name", "shiftStartTime"]), []);
});

test("missing, null and undefined all mean not set, and key order does not matter", () => {
  const saved = {
    name: "Maria Santos",
    shiftStartTime: "09:00",
    workingDays: [1, 2, 3, 4, 5],
    companyMemberships: { alpha: { shiftStartTime: "09:00", status: "active" } },
  };
  assert.deepEqual(changedFields(opened, saved, Object.keys(opened)), []);
});

test("timestamps compare by instant", () => {
  const at = (ms: number) => ({ toMillis: () => ms });
  assert.deepEqual(changedFields({ createdAt: at(5) }, { createdAt: at(5) }, ["createdAt"]), []);
  assert.deepEqual(changedFields({ createdAt: at(5) }, { createdAt: at(6) }, ["createdAt"]), [
    "createdAt",
  ]);
});
