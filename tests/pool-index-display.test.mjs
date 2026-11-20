import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("index column shows daily high, low, close and change versus prior close",async()=>{
  const source=await readFile(new URL("../static/app.js",import.meta.url),"utf8");
  const render=source.slice(source.indexOf("  function renderPoolStats(){"),source.indexOf("  function renderTable(){"));
  const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{textContent:"",innerHTML:""});return elements.get(id);};
  const context=vm.createContext({$,poolStats:[{date:"20261119",pool_name:"合计"},{date:"20261120",pool_name:"合计"},{date:"20261118",pool_name:"合计"}],shanghaiIndex:new Map([["20261119",{high:3540,low:3500,close:3533.79,prev_close:3500}],["20261120",{high:3550,low:3480,close:3490,prev_close:3533.79}]]),indexLoading:false,poolStatsStale:false,shanghaiNow:()=>"2026-11-20 14:00:00",number:(n,d)=>Number(n).toFixed(d),signed:(n,d)=>`${Number(n)>0?"+":""}${Number(n).toFixed(d)}`,tone:n=>Number(n)>0?"pos":Number(n)<0?"neg":"neutral",shortDate:x=>x,esc:x=>String(x)});
  vm.runInContext(`${render}\nrenderPoolStats();`,context);
  const html=elements.get("pool-stats-rows").innerHTML,rows=html.match(/<tr\b[\s\S]*?<\/tr>/g);
  const prior=rows.find(row=>row.includes('data-date="20261119"')),today=rows.find(row=>row.includes('data-date="20261120"')),missing=rows.find(row=>row.includes('data-date="20261118"'));
  assert.match(prior,/<small>最高<\/small>3540\.00.*<small>最低<\/small>3500\.00.*<small>收盘<\/small>3533\.79.*index-change pos.*\+0\.97%/);
  assert.match(today,/<small>最新<\/small>3490\.00.*index-change neg.*-1\.24%/);
  assert.match(missing,/<td class="right money">—<\/td><\/tr>$/);
  for(const row of rows)assert.match(row,/<td class="right money">(?:<div class="index-points">[\s\S]*?<\/div>|—)<\/td><\/tr>$/);
  const page=await readFile(new URL("../static/index.html",import.meta.url),"utf8");
  assert.match(page,/最高 \/ 最低 \/ 收盘 \/ 涨跌幅/);
  context.shanghaiIndex.set("20261118",{high:null,low:null,close:3450,prev_close:null});
  vm.runInContext("renderPoolStats();",context);
  const first=elements.get("pool-stats-rows").innerHTML.match(/<tr\b[^>]*data-date="20261118"[\s\S]*?<\/tr>/)[0];
  assert.match(first,/<small>最高<\/small>—.*<small>最低<\/small>—.*<small>收盘<\/small>3450\.00.*<small>涨跌幅<\/small>—/);
});
