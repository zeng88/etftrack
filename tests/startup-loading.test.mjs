import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html=await readFile(new URL("../static/index.html",import.meta.url),"utf8");
const script=html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
function start(){
  const names=new Set(),listeners={},nodes=new Map(),timers=[];
  for(const id of ["startup-message","startup-retry","data-load-message","data-load-retry","data-load-hint"])nodes.set(id,{textContent:"",hidden:id.includes("retry")});
  const document={documentElement:{classList:{add(...tokens){tokens.forEach(t=>names.add(t));},remove(t){names.delete(t);},contains:t=>names.has(t)}},getElementById:id=>nodes.get(id),addEventListener:(name,fn)=>{listeners[name]=fn;}};
  const context={document,window:{},Date,setTimeout:fn=>timers.push(fn)};vm.runInNewContext(script,context);
  return {context,names,listeners,nodes,timers,style:ok=>context.window.siteStyleSettled({dataset:{},media:"print"},ok)};
}
test("startup screen waits for styles and DOM, not market data",()=>{
  const s=start();assert.ok(s.names.has("site-booting"));
  for(let i=0;i<3;i++)s.style(true);s.listeners.DOMContentLoaded();assert.ok(s.names.has("site-booting"));
  s.style(true);assert.ok(!s.names.has("site-booting"));assert.equal(s.nodes.get("data-load-hint").hidden,false);
  s.context.window.markDashboardReady();assert.equal(s.nodes.get("data-load-hint").hidden,true);
});
test("slow or failed resources expose retry and never pretend the page is ready",()=>{
  const slow=start();slow.timers[0]();assert.match(slow.nodes.get("startup-message").textContent,/网络较慢/);assert.equal(slow.nodes.get("startup-retry").hidden,false);
  const failed=start();failed.style(false);for(let i=0;i<3;i++)failed.style(true);failed.listeners.DOMContentLoaded();assert.ok(failed.names.has("site-booting"));assert.match(failed.nodes.get("startup-message").textContent,/加载失败/);assert.equal(failed.nodes.get("startup-retry").hidden,false);
});
test("data failure offers retry and later success hides the message",()=>{
  const s=start();s.context.window.markDashboardError();assert.match(s.nodes.get("data-load-message").textContent,/无法加载/);assert.equal(s.nodes.get("data-load-retry").hidden,false);
  s.timers[0]();assert.match(s.nodes.get("data-load-message").textContent,/无法加载/);
  s.context.window.markDashboardReady();assert.equal(s.nodes.get("data-load-hint").hidden,true);
});
test("slow data exposes a separate retry after the page is ready",()=>{
  const s=start();for(let i=0;i<4;i++)s.style(true);s.listeners.DOMContentLoaded();s.timers[0]();
  assert.ok(!s.names.has("site-booting"));assert.match(s.nodes.get("data-load-message").textContent,/加载较慢/);assert.equal(s.nodes.get("data-load-retry").hidden,false);
});
test("all four stylesheets load asynchronously with a no-script fallback",()=>{
  assert.equal((html.match(/media="print" onload="siteStyleSettled/g)||[]).length,4);
  assert.match(html,/<noscript>[\s\S]*?href="\/styles\.css"[\s\S]*?<\/noscript>/);
});
