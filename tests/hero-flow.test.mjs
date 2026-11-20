import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("hero buy and sell proportions follow the estimated amounts", async () => {
  const source=await readFile(new URL("../static/app.js",import.meta.url),"utf8");
  const render=source.slice(source.indexOf("  function renderLiveFlow(){"),source.indexOf("  let liveRefreshBusy=false;"));
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,{style:{setProperty(k,v){this[k]=v;}},parentElement:{style:{}},classList:{remove(){}},querySelector(){return {};},setAttribute(k,v){this[k]=v;}});return elements.get(id);};
  const context={ $:get, liveFlow:{time:"20261120140000",buy_yi:368.42,sell_yi:309.36,net_yi:59.06,amount_yi:677.78,core_count:34}, shanghaiNow:()=>"2026-11-20 14:00:00", marketPhase:()=>"open", dateLabel:x=>x, timeLabel:x=>x, localClock:()=>"14:00", number:(x,d)=>Number(x).toFixed(d),signed:(x,d)=>`${x>0?"+":""}${Number(x).toFixed(d)}`,tone:()=>"pos",Date,Math,Number,String,Infinity};
  vm.runInNewContext(`${render}\nrenderLiveFlow();`,context);
  assert.equal(get("live-total").textContent,"677.78 亿");
  assert.equal(get("buy-share").textContent,"54.36%");
  assert.equal(get("sell-share").textContent,"45.64%");
  assert.equal(get("signal-buy-share").textContent,"54.36%");
  assert.equal(get("legend-buy").textContent,"368.42 亿");
  assert.equal(get("signal-sell-amount").textContent,"309.36 亿");
  assert.match(get("flow-donut")["aria-label"],/54\.36%.*45\.64%/);
  context.liveFlow.buy_yi=0;context.liveFlow.sell_yi=0;
  vm.runInNewContext("renderLiveFlow();",context);
  assert.equal(get("buy-share").textContent,"—");
  assert.equal(get("flow-donut").style["--sell-color"],"#425873");
  context.liveFlow.buy_yi=1;context.liveFlow.sell_yi=99;
  vm.runInNewContext("renderLiveFlow();",context);
  assert.equal(get("signal-buy-share").style.visibility,"hidden");
  assert.equal(get("signal-buy-fallback").textContent,"1.00%");
});
