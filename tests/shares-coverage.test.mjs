import assert from "node:assert/strict";
import test from "node:test";
import { hasUsableShareCoverage } from "../src/db.ts";

test("any exchange coverage is shown with its coverage label", () => {
  assert.equal(hasUsableShareCoverage(34, 34), true);
  assert.equal(hasUsableShareCoverage(34, 33), true);
  assert.equal(hasUsableShareCoverage(34, 1), true);
});

test("a date with no exchange coverage has nothing to show yet", () => {
  assert.equal(hasUsableShareCoverage(34, 0), false);
  assert.equal(hasUsableShareCoverage(0, 0), false);
});
