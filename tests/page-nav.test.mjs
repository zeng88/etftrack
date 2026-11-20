import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("page navigation opens, follows the visible section and closes on mobile or Escape",async()=>{
  const html=await readFile(new URL("../static/index.html",import.meta.url),"utf8");
  const names=[...html.matchAll(/<a href="#([^"]+)"><i aria-hidden="true"><\/i><span>/g)].map(m=>m[1]);
  assert.equal(names.length,8);
  for(const id of names)assert.match(html,new RegExp(`id="${id}"`));
  const attrs=()=>({values:{},setAttribute(k,v){this.values[k]=v;},getAttribute(k){return this.values[k]},removeAttribute(k){delete this.values[k]},addEventListener(k,fn){this[k]=fn;}});
  const links=names.map(id=>Object.assign(attrs(),{getAttribute(k){return k==="href"?`#${id}`:this.values[k];}}));
  const panel=Object.assign(attrs(),{inert:true,querySelectorAll(){return links;}});
  const toggle=Object.assign(attrs(),{focus(){this.focused=true;}});
  const classes=new Set(),nav={querySelector(){return toggle;},contains(target){return target===toggle;},classList:{toggle(name,on){on?classes.add(name):classes.delete(name);}}};
  const sections=names.map((_,i)=>({top:i*500,getBoundingClientRect(){return {top:this.top};}}));
  const document={handlers:{},querySelector(){return nav;},getElementById(id){return id==="page-nav-panel"?panel:sections[names.indexOf(id)];},addEventListener(k,fn){this.handlers[k]=fn;}};
  const window={innerHeight:800,handlers:{},matchMedia(){return {matches:true};},addEventListener(k,fn){this.handlers[k]=fn;}};
  const source=await readFile(new URL("../static/page-nav.js",import.meta.url),"utf8");
  vm.runInNewContext(source,{document,window,requestAnimationFrame:fn=>fn(),String,Math});
  assert.equal(toggle.values["aria-expanded"],"false");assert.equal(links[0].tabIndex,-1);
  toggle.click();assert.equal(toggle.values["aria-expanded"],"true");assert.equal(panel.inert,false);assert.equal(links[0].tabIndex,0);
  sections.forEach((s,i)=>s.top=(i-5)*500);window.handlers.scroll();assert.equal(links[5].values["aria-current"],"location");
  links[5].click();assert.equal(toggle.values["aria-expanded"],"false");
  toggle.click();document.handlers.keydown({key:"Escape"});assert.equal(panel.inert,true);assert.equal(toggle.focused,true);
});
