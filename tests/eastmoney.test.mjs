import assert from "node:assert/strict";
import test from "node:test";
import { fetchEastmoneyQuotes, fetchEastmoneyShares, fetchScheduledQuotes } from "../src/collector.ts";

test("Eastmoney fallback maps price, turnover and the Shanghai quote time", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith("https://push2.eastmoney.com/api/qt/ulist.np/get")) {
      return new Response(JSON.stringify({
        data: {
          diff: [{
            f12: "510300", f14: "沪深300ETF", f2: 4.042, f3: -0.3, f5: 20078506,
            f6: 8114734031, f18: 4.054, f20: 189978800215, f124: 1794903115,
          }],
        },
      }));
    }
    throw new Error(`unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const quotes = await fetchEastmoneyQuotes([{ code: "510300", tcode: "sh510300" }]);
  const quote = quotes.get("510300");
  assert.equal(quote.date, "20261117");
  assert.equal(quote.ts, "20261117161155");
  assert.equal(quote.price, 4.042);
  assert.equal(quote.prev_close, 4.054);
  assert.equal(quote.volume_lots, 20078506);
  assert.ok(Math.abs(quote.amount_yi - 81.14734031) < 1e-6);
});

test("scheduled quotes fall back to Eastmoney when Tencent is unavailable", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith("https://qt.gtimg.cn/")) throw new Error("tencent down");
    if (url.startsWith("https://push2.eastmoney.com/api/qt/ulist.np/get")) {
      return new Response(JSON.stringify({
        data: {
          diff: [
            { f12: "510300", f14: "沪深300ETF", f2: 4.042, f3: -0.3, f5: 20078506, f6: 8114734031, f18: 4.054, f20: 189978800215, f124: 1794903115 },
            { f12: "159919", f14: "沪深300ETF嘉实", f2: 4.222, f3: -0.2, f5: 1000000, f6: 422200000, f18: 4.23, f20: 58426639183, f124: 1794903115 },
          ],
        },
      }));
    }
    throw new Error(`unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const etfs = [
    { code: "510300", tcode: "sh510300", group_name: "core" },
    { code: "159919", tcode: "sz159919", group_name: "core" },
  ];
  const result = await fetchScheduledQuotes(etfs);
  assert.equal(result.source, "东方财富行情兜底");
  assert.equal(result.quotes.get("510300").date, "20261117");
  assert.equal(result.quotes.get("159919").price, 4.222);
});

test("Eastmoney fund shares are returned as a fallback share value", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith("https://push2.eastmoney.com/api/qt/stock/get")) {
      return new Response(JSON.stringify({ data: { f84: 47001187584 } }));
    }
    throw new Error(`unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await fetchEastmoneyShares("510300", "sh510300"), 47001187584);
});
