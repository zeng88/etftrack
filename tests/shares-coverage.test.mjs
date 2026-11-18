import assert from "node:assert/strict";
import test from "node:test";
import { hasUsableShareCoverage } from "../src/db.ts";

test("one or two missing exchange disclosures are still shown with coverage", () => {
  assert.equal(hasUsableShareCoverage(34, 34), true);
  assert.equal(hasUsableShareCoverage(34, 33), true);
  assert.equal(hasUsableShareCoverage(34, 32), true);
});

test("a broader disclosure outage is hidden until retry fills it", () => {
  assert.equal(hasUsableShareCoverage(34, 31), false);
  assert.equal(hasUsableShareCoverage(34, 0), false);
  assert.equal(hasUsableShareCoverage(0, 0), false);
});
