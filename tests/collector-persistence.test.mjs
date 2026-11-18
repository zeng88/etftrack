import assert from "node:assert/strict";
import test from "node:test";
import { collectConfirmedDaily } from "../src/collector.ts";

const officialSources = new Set(["上交所 ETF 规模披露", "深交所 ETF 规模披露"]);

function quote(code, name, tcode, stamp) {
  const fields = Array(73).fill("0");
  fields[1] = name;
  fields[3] = "4.000";
  fields[4] = "3.900";
  fields[6] = "1000";
  fields[7] = "600";
  fields[8] = "400";
  fields[30] = stamp;
  fields[32] = "2.56";
  fields[37] = "100000";
  fields[45] = "100000000";
  fields[72] = "1000000000";
  const exchange = tcode.slice(0, 2);
  return `v_${exchange}${code}="${fields.join("~")}";`;
}

function createDb(etfs) {
  const state = { etfs, shares: new Map(), snapshots: new Map(), activity: new Map(), closes: new Map(), runs: [], shareWrites: 0 };
  const prepare = sql => {
    const statement = { sql, args: [], bind(...args) { this.args = args; return this; } };
    statement.all = async () => {
      const [date = "", after = ""] = statement.args;
      if (sql.includes("SELECT code,tcode,name,group_name FROM etfs")) return { results: etfs };
      if (sql.includes("SELECT DISTINCT trade_date FROM daily_snapshots")) return { results: [...new Set([...state.snapshots.values()].filter(row => row.trade_date > date).map(row => row.trade_date).concat([...state.activity.values()].filter(row => row.trade_date > date).map(row => row.trade_date)))].sort().map(trade_date => ({ trade_date })) };
      if (sql.includes("SELECT code FROM share_history WHERE trade_date=?")) return { results: [...state.shares.values()].filter(row => row.trade_date === date && officialSources.has(row.source)).map(row => ({ code: row.code })) };
      if (sql.includes("SELECT s.code,s.shares FROM share_history")) {
        const prior = new Map();
        for (const row of state.shares.values()) if (row.trade_date < date && officialSources.has(row.source) && (!prior.has(row.code) || prior.get(row.code).trade_date < row.trade_date)) prior.set(row.code, row);
        return { results: [...prior.values()].map(({ code, shares }) => ({ code, shares })) };
      }
      if (sql.includes("SELECT code FROM daily_snapshots WHERE trade_date=?")) return { results: [...state.snapshots.values()].filter(row => row.trade_date === date).map(row => ({ code: row.code })) };
      if (sql.includes("SELECT code FROM daily_activity WHERE trade_date=?")) return { results: [...state.activity.values()].filter(row => row.trade_date === date).map(row => ({ code: row.code })) };
      return { results: [] };
    };
    statement.first = async () => {
      const [date] = statement.args;
      if (sql.includes("SELECT MAX(trade_date) AS d FROM daily_snapshots")) {
        const days = [...new Set([...state.snapshots.values()].map(row => row.trade_date))].filter(day => day < date).sort();
        return days.length ? { d: days.at(-1) } : null;
      }
      if (sql.includes("SELECT s.trade_date FROM share_history")) {
        const counts = new Map();
        for (const row of state.shares.values()) if (officialSources.has(row.source) && etfs.some(etf => etf.code === row.code && etf.group_name === "core")) counts.set(row.trade_date, (counts.get(row.trade_date) || 0) + 1);
        const latest = [...counts].filter(([, count]) => count === etfs.filter(etf => etf.group_name === "core").length).map(([day]) => day).sort().at(-1);
        return latest ? { trade_date: latest } : null;
      }
      if (sql.includes("COUNT(DISTINCT s.code) AS count")) {
        const count = new Set([...state.shares.values()].filter(row => row.trade_date === date && officialSources.has(row.source)).map(row => row.code)).size;
        return { count };
      }
      return null;
    };
    statement.run = async () => {
      state.runs.push(statement.args);
      return { success: true };
    };
    return statement;
  };
  const db = {
    prepare,
    async batch(statements) {
      for (const statement of statements) {
        const [trade_date, code, value, observed_at, source] = statement.args;
        if (statement.sql.includes("INSERT INTO share_history")) {
          state.shares.set(`${trade_date}:${code}`, { trade_date, code, shares: value, observed_at, source });
          state.shareWrites++;
        } else if (statement.sql.includes("daily_snapshots")) {
          state.snapshots.set(`${trade_date}:${code}`, { trade_date, code });
        } else if (statement.sql.includes("daily_activity")) {
          state.activity.set(`${trade_date}:${code}`, { trade_date, code });
        } else if (statement.sql.includes("daily_closes")) {
          state.closes.set(`${trade_date}:${code}`, { trade_date, code, close_price: value });
        }
      }
      return [];
    },
  };
  return { db, state };
}

test("retry fills missing official ETF shares without rewriting the saved close snapshot", async t => {
  const etfs = [
    { code: "510300", tcode: "sh510300", name: "沪深300ETF", group_name: "core" },
    { code: "159919", tcode: "sz159919", name: "沪深300ETF嘉实", group_name: "core" },
  ];
  const { db, state } = createDb(etfs);
  // The scheduler always re-checks the previous weekday; keep it complete so
  // this test focuses on filling the current session.
  state.shares.set("20261113:510300", { trade_date: "20261113", code: "510300", shares: 1, observed_at: "x", source: "上交所 ETF 规模披露" });
  state.shares.set("20261113:159919", { trade_date: "20261113", code: "159919", shares: 1, observed_at: "x", source: "深交所 ETF 规模披露" });
  let szCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith("https://qt.gtimg.cn/")) return new Response(quote("510300", "沪深300ETF", "sh510300", "20261116150000") + quote("159919", "沪深300ETF嘉实", "sz159919", "20261116150000"));
    if (url.startsWith("https://query.sse.com.cn/")) return new Response(JSON.stringify({ result: [{ SEC_CODE: "510300", TOT_VOL: "100" }] }));
    if (url.startsWith("https://www.szse.cn/")) {
      szCalls++;
      if (szCalls === 1) return new Response("temporary error", { status: 503 });
      return new Response(JSON.stringify([{ data: [{ size_date: "2026-11-16", current_size: "200" }] }]));
    }
    throw new Error(`unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const timestamp = Date.parse("2026-11-16T15:15:00Z");
  const first = await collectConfirmedDaily({ DB: db }, timestamp);
  assert.equal(first.confirmed_shares, false);
  assert.equal(first.coverage, 1);
  assert.equal(state.snapshots.size, 2);
  assert.equal(state.activity.size, 2);
  assert.equal(state.closes.size, 2);
  assert.equal(state.shareWrites, 1);

  const second = await collectConfirmedDaily({ DB: db }, timestamp + 60_000);
  assert.equal(second.confirmed_shares, true);
  assert.equal(second.coverage, 2);
  assert.equal(state.snapshots.size, 2);
  assert.equal(state.activity.size, 2);
  assert.equal(state.shareWrites, 2);
  assert.equal(state.shares.get("20261116:159919").source, "深交所 ETF 规模披露");
});

test("intraday retry does not persist the current session as a close", async t => {
  const etfs = [
    { code: "510300", tcode: "sh510300", name: "沪深300ETF", group_name: "core" },
    { code: "159919", tcode: "sz159919", name: "沪深300ETF嘉实", group_name: "core" },
  ];
  const { db, state } = createDb(etfs);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith("https://qt.gtimg.cn/")) return new Response(quote("510300", "沪深300ETF", "sh510300", "20261118133000") + quote("159919", "沪深300ETF嘉实", "sz159919", "20261118133000"));
    throw new Error(`unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await collectConfirmedDaily({ DB: db }, Date.parse("2026-11-18T05:30:00Z"));
  assert.equal(result.confirmed_shares, false);
  assert.equal(state.snapshots.size, 0);
  assert.equal(state.activity.size, 0);
  assert.equal(state.closes.size, 0);
});

test("intraday retry heals the previous session close from prev_close", async t => {
  const etfs = [
    { code: "510300", tcode: "sh510300", name: "沪深300ETF", group_name: "core" },
    { code: "159919", tcode: "sz159919", name: "沪深300ETF嘉实", group_name: "core" },
  ];
  const { db, state } = createDb(etfs);
  state.snapshots.set("20261117:510300", { trade_date: "20261117", code: "510300" });
  state.snapshots.set("20261117:159919", { trade_date: "20261117", code: "159919" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.startsWith("https://qt.gtimg.cn/")) return new Response(quote("510300", "沪深300ETF", "sh510300", "20261118133000") + quote("159919", "沪深300ETF嘉实", "sz159919", "20261118133000"));
    throw new Error(`unexpected URL ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await collectConfirmedDaily({ DB: db }, Date.parse("2026-11-18T05:30:00Z"));
  assert.equal(state.snapshots.size, 2);
  assert.equal(state.closes.size, 2);
  assert.equal(state.closes.get("20261117:510300").close_price, 3.9);
});
