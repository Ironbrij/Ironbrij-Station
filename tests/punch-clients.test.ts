import test from "node:test";
import assert from "node:assert/strict";
import { groupPunchesByClient } from "../src/lib/punch-clients.ts";
import type { Punch } from "../src/lib/types.ts";

const at = (time: string) => new Date(`2026-09-21T${time}:00Z`);
const punch = (id: string, type: Punch["type"], time: string, companyId: string) =>
  ({ id, employeeId: "uid", type, timestamp: at(time), companyId }) as unknown as Punch;
const clientNameOf = (p: Punch) => (p.companyId === "acme" ? "Acme" : "Northwind");

test("a day split across clients reads as one block per client", () => {
  const groups = groupPunchesByClient(
    [
      punch("a-in", "in", "06:00", "acme"),
      punch("a-out", "out", "10:00", "acme"),
      punch("n-in", "in", "10:00", "north"),
      punch("n-out", "out", "11:03", "north"),
      punch("a-in-2", "in", "11:04", "acme"),
    ],
    clientNameOf,
  );
  assert.deepEqual(
    groups.map((group) => [group.client, group.punches.map((p) => p.id)]),
    [
      ["Acme", ["a-in", "a-out", "a-in-2"]],
      ["Northwind", ["n-in", "n-out"]],
    ],
  );
});

test("groups appear in the order each client first shows up, whatever the input order", () => {
  const groups = groupPunchesByClient(
    [punch("n-in", "in", "10:00", "north"), punch("a-in", "in", "06:00", "acme")],
    clientNameOf,
  );
  assert.deepEqual(
    groups.map((group) => group.client),
    ["Acme", "Northwind"],
  );
});

test("a punch with no resolvable client still appears", () => {
  const groups = groupPunchesByClient([punch("x", "in", "06:00", "acme")], () => "");
  assert.deepEqual(
    groups.map((group) => group.client),
    ["Unassigned client"],
  );
});
