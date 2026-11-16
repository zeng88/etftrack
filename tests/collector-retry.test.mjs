import assert from "node:assert/strict";
import test from "node:test";
import { fetchLiveFlow, missingEtfsForDate, shareRetryDates } from "../src/collector.ts";
import { LIVE_ETFS } from "../src/etf-list.ts";

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

test("live flow calculates from the published ETF basket without reading D1", async t => {
  const fields = Array(73).fill("0");
  const raw = LIVE_ETFS.map(etf => {
    const quote = [...fields];
    quote[1] = etf.name;
    quote[3] = "4.000";
    quote[4] = "3.900";
    quote[6] = "1000";
    quote[7] = "600";
    quote[8] = "400";
    quote[30] = "20261116150000";
    quote[32] = "2.56";
    quote[37] = "100000";
    quote[45] = "100000000";
    quote[72] = "1000000000";
    return `v_${etf.tcode}="${quote.join("~")}";`;
  }).join("");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(raw);
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await fetchLiveFlow();
  assert.equal(result.core_count, 34);
  assert.equal(result.total_count, 35);
  assert.equal(result.quote_count, 35);
  assert.equal(result.date, "20261116");
});
