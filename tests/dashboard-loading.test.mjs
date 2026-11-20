import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source=await readFile(new URL("../static/app.js",import.meta.url),"utf8");
const loader=source.slice(source.indexOf("  async function readData("),source.indexOf("  function turnoverAt("));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=data=>({ok:true,json:async()=>data});
function setup(){
  const requests=[],events=[],elements=new Map();
  const context=vm.createContext({AbortSignal,console:{warn(){}},fetch(url){const d=deferred();requests.push({url,...d});return d.promise;},events,$:id=>{if(!elements.has(id))elements.set(id,{textContent:"",innerHTML:""});return elements.get(id);},renderStatus(){events.push("dashboard");},renderSummary(){},renderPoolCharts(){},renderTable(){},renderLiveFlow(){},renderPoolStats(){events.push("stats");},renderFlowOverview(){events.push("overview");},applyLiveQuotes(){}});
  vm.runInContext(`let dashboard=null,flowOverview=null,poolStats=[],statsDays=20,liveFlow=null,dashboardRequest=0,statsRequest=0,overviewRequest=0,hasPoolStats=false,poolStatsStale=false;${loader}`,context);
  return {context,requests,events,elements};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test("dashboard renders without waiting for the other two requests",async()=>{
  const {context,requests,events}=setup();
  const done=vm.runInContext("loadDashboard()",context);
  requests.find(r=>r.url==="/api/dashboard").resolve(response({etfs:[{code:"510300"}]}));
  await done;assert.deepEqual(events,["dashboard"]);
  requests.find(r=>r.url.startsWith("/api/pool-stats")).resolve(response({rows:[{}]}));
  await settle();assert.deepEqual(events,["dashboard","stats"]);
  requests.find(r=>r.url==="/api/flow-overview").resolve(response({metrics:[{}]}));
  await settle();assert.deepEqual(events,["dashboard","stats","overview"]);
});
test("a failed overview does not prevent dashboard and stats from rendering",async()=>{
  const {context,requests,events,elements}=setup();
  const done=vm.runInContext("loadDashboard()",context);
  requests.find(r=>r.url==="/api/flow-overview").reject(new Error("offline"));
  requests.find(r=>r.url.startsWith("/api/pool-stats")).resolve(response({rows:[{}]}));
  requests.find(r=>r.url==="/api/dashboard").resolve(response({etfs:[{}]}));
  await done;await settle();assert.ok(events.includes("dashboard"));assert.ok(events.includes("stats"));
  assert.match(elements.get("flow-overview-meta").textContent,/暂时无法加载/);
});
test("secondary sections can still load when the dashboard fails",async()=>{
  const {context,requests,events}=setup();
  const done=vm.runInContext("loadDashboard()",context);
  requests.find(r=>r.url==="/api/dashboard").reject(new Error("offline"));
  requests.find(r=>r.url.startsWith("/api/pool-stats")).resolve(response({rows:[{}]}));
  requests.find(r=>r.url==="/api/flow-overview").resolve(response({metrics:[{}]}));
  await assert.rejects(done,/offline/);await settle();
  assert.ok(events.includes("stats"));assert.ok(events.includes("overview"));
});
test("a failed refresh retains the last stats and identifies them as old",async()=>{
  const {context,requests,elements}=setup();
  const first=vm.runInContext("loadPoolStats()",context);
  requests[0].resolve(response({rows:[{date:"existing"}]}));await first;
  const second=vm.runInContext("loadPoolStats()",context);
  requests[1].reject(new Error("offline"));await second;
  assert.equal(vm.runInContext("poolStats[0].date",context),"existing");
  assert.match(elements.get("pool-stats-count").textContent,/保留上次数据/);
});
test("outdated stats requests do not overwrite a newer selection",async()=>{
  const {context,requests,events}=setup();
  const first=vm.runInContext("loadPoolStats()",context);
  vm.runInContext("statsDays=60",context);
  const second=vm.runInContext("loadPoolStats()",context);
  requests[1].resolve(response({rows:[{date:"new"}]}));await second;
  requests[0].resolve(response({rows:[{date:"old"}]}));await first;
  assert.equal(vm.runInContext("poolStats[0].date",context),"new");assert.deepEqual(events,["stats"]);
});
