import assert from "node:assert/strict";
import test from "node:test";
import { validAttachments } from "../src/lib/leave-attachments.ts";

const good = "data:image/jpeg;base64,/9j/4AAQ";

test("only small jpeg data URLs get through, at most three", () => {
  const out = validAttachments([good, "https://evil.test/x.png", "data:text/html;base64,AA", 5, good, good, good]);
  assert.deepEqual(out, [good, good, good]);
});

test("a missing or odd value gives no attachments", () => {
  assert.deepEqual(validAttachments(undefined), []);
  assert.deepEqual(validAttachments("data:image/jpeg;base64,x"), []);
});
