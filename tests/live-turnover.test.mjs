import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveTurnoverComparison } from "../src/collector.ts";

test("builds same-basket cumulative turnover curves and appends a newer Tencent point", () => {
  const etfs=[
    {code:"510300",tcode:"sh510300",name:"沪深300ETF"},
    {code:"510050",tcode:"sh510050",name:"上证50ETF"},
  ];
  const rawBars=new Map([
    ["510300",[
      {day:"2026-11-14 09:35:00",amount:"100000000"},{day:"2026-11-14 09:40:00",amount:"200000000"},
      {day:"2026-11-17 09:35:00",amount:"300000000"},{day:"2026-11-17 09:40:00",amount:"400000000"},
    ]],
    ["510050",[
      {day:"2026-11-14 09:35:00",amount:"50000000"},{day:"2026-11-14 09:40:00",amount:"150000000"},
      {day:"2026-11-17 09:35:00",amount:"100000000"},{day:"2026-11-17 09:40:00",amount:"200000000"},
    ]],
  ]);
  const quotes=new Map([["510300",{ts:"20261117094500",amount_yi:9}],["510050",{ts:"20261117094500",amount_yi:4}]]);

  const result=buildLiveTurnoverComparison(etfs,rawBars,quotes);

  assert.equal(result.date,"20261117");
  assert.equal(result.previous_date,"20261114");
  assert.equal(result.comparison_count,2);
  assert.deepEqual(result.items[0].previous,[{time:"09:35",amount_yi:1},{time:"09:40",amount_yi:3}]);
  assert.deepEqual(result.items[0].today.at(-1),{time:"09:45",amount_yi:9});
  assert.deepEqual(result.aggregate.today.at(-1),{time:"09:45",amount_yi:13});
});

test("does not use a stale Tencent quote to alter the latest five-minute point", () => {
  const etfs=[{code:"510300",tcode:"sh510300",name:"沪深300ETF"}];
  const rawBars=new Map([["510300",[
    {day:"2026-11-14 09:35:00",amount:"100000000"},{day:"2026-11-17 09:35:00",amount:"200000000"},{day:"2026-11-17 09:40:00",amount:"300000000"},
  ]]]);
  const result=buildLiveTurnoverComparison(etfs,rawBars,new Map([["510300",{ts:"20261117093500",amount_yi:99}]]));
  assert.deepEqual(result.items[0].today.at(-1),{time:"09:40",amount_yi:5});
});

test("keeps the 15:00 close curve intact when Tencent publishes an after-close timestamp", () => {
  const etfs=[{code:"510300",tcode:"sh510300",name:"沪深300ETF"}];
  const rawBars=new Map([["510300",[
    {day:"2026-11-14 15:00:00",amount:"100000000"},{day:"2026-11-17 14:55:00",amount:"200000000"},{day:"2026-11-17 15:00:00",amount:"300000000"},
  ]]]);
  const result=buildLiveTurnoverComparison(etfs,rawBars,new Map([["510300",{ts:"20261117155900",amount_yi:0}]]));
  assert.deepEqual(result.items[0].today.at(-1),{time:"15:00",amount_yi:5});
});
