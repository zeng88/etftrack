import assert from "node:assert/strict";
import test from "node:test";
import { missingEtfsForDate, shareRetryDates } from "../src/collector.ts";

test("retry schedule caps work at two dates while keeping the current incomplete date", () => {
  assert.deepEqual(shareRetryDates("20261117", false, ["20261113", "20261114", "20261115", "20261117"]), ["20261113", "20261117"]);
});

test("a complete current day is not re-collected, but older pending dates remain eligible", () => {
  assert.deepEqual(shareRetryDates("20261117", true, ["20261113", "20261114", "20261115", "20261116"]), ["20261113", "20261114"]);
});

test("snapshot collection selects only missing ETF rows", () => {
  const etfs = [{ code: "510300" }, { code: "510500" }, { code: "510050" }];
  assert.deepEqual(missingEtfsForDate(etfs, [{ code: "510300" }, { code: "510050" }]), [{ code: "510500" }]);
  assert.deepEqual(missingEtfsForDate(etfs, etfs), []);
});
