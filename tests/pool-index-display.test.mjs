import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("share statistics match index points by trade date and label today's value as latest",async()=>{
  const source=await readFile(new URL("../static/app.js",import.meta.url),"utf8");
  const render=source.slice(source.indexOf("  function renderPoolStats(){"),source.indexOf("  function renderTable(){"));
  const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{textContent:"",innerHTML:""});return elements.get(id);};
  const context=vm.createContext({$,poolStats:[{date:"20261119",pool_name:"合计"},{date:"20261120",pool_name:"合计"},{date:"20261118",pool_name:"合计"}],shanghaiIndex:new Map([["20261119",{open:3527.3,close:3533.79}],["20261120",{open:3500,close:3490}]]),indexLoading:false,poolStatsStale:false,shanghaiNow:()=>"2026-11-20 14:00:00",number:(n,d)=>Number(n).toFixed(d),signed:(n,d)=>`${Number(n)>0?"+":""}${Number(n).toFixed(d)}`,tone:n=>Number(n)>0?"pos":Number(n)<0?"neg":"neutral",shortDate:x=>x,esc:x=>String(x)});
  vm.runInContext(`${render}\nrenderPoolStats();`,context);
  const html=elements.get("pool-stats-rows").innerHTML;
  assert.match(html,/data-date="20261119"[\s\S]*?<small>开<\/small>3527\.30[\s\S]*?<small>收<\/small>3533\.79/);
  assert.match(html,/data-date="20261119"[\s\S]*?index-change pos[\s\S]*?\+6\.49 点 · \+0\.18%/);
  assert.match(html,/data-date="20261120"[\s\S]*?<small>最新<\/small>3490\.00[\s\S]*?index-change neg[\s\S]*?-10\.00 点 · -0\.29%/);
  assert.match(html,/data-date="20261118"[\s\S]*?<td class="right money">—<\/td>/);
  for(const row of html.match(/<tr\b[\s\S]*?<\/tr>/g))assert.match(row,/<td class="right money">(?:<div class="index-points">[\s\S]*?<\/div>|—)<\/td><\/tr>$/);
  const page=await readFile(new URL("../static/index.html",import.meta.url),"utf8");
  assert.match(page,/<th>变化信号<\/th><th class="right">上证指数<br>开盘 \/ 收盘 \/ 较开盘<\/th>/);
});
