import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("gold chart renders intraday and accurate OHLC candles with currency switching", async () => {
  const elements=new Map();
  const element=()=>({textContent:"",innerHTML:"",dataset:{},attributes:{},classList:{add(){},remove(){}},getBoundingClientRect(){return {left:0,width:1000};},addEventListener(name,fn){this[name]=fn;},setAttribute(k,v){this.attributes[k]=v;}});
  for(const id of ["gold-chart","gold-detail","gold-price-label","gold-price","gold-price-unit","gold-freshness","gold-fx"])elements.set(id,element());
  const units=["cny","usd"].map(value=>Object.assign(element(),{dataset:{goldUnit:value}}));
  const ranges=["intraday","day","week","month","year"].map(value=>Object.assign(element(),{dataset:{goldRange:value}}));
  const epoch=date=>Date.parse(date+"T12:00:00Z")/1000;
  const daily=[
    {t:epoch("2026-11-09"),o:80,h:100,l:70,c:90},
    {t:epoch("2026-11-16"),o:90,h:110,l:80,c:100},
    {t:epoch("2026-11-19"),o:100,h:120,l:95,c:110},
  ];
  const monthly=[
    {t:epoch("2025-01-01"),o:50,h:70,l:40,c:60},
    {t:epoch("2026-01-01"),o:60,h:80,l:55,c:75},
    {t:epoch("2026-10-01"),o:75,h:95,l:65,c:90},
    {t:epoch("2026-11-19"),o:100,h:105,l:95,c:102},
  ];
  const calls=[];
  const document={getElementById:id=>elements.get(id),querySelectorAll:selector=>selector.includes("unit")?units:ranges,addEventListener(){},hidden:false};
  const fetch=async url=>{calls.push(url);let result;if(url.includes("spot?"))result={spot_usd_oz:110,fx_rate:7,xau:{price:24.76},data_state:{status:"fresh",as_of:"2026-11-20T04:30:00Z"}};else if(url.includes("intraday"))result={points:[{t:Date.parse("2026-11-19T12:00:00Z")/1000,p:9999},{t:Date.parse("2026-11-19T16:00:00Z")/1000,p:100},{t:Date.parse("2026-11-20T02:30:00Z")/1000,p:110},{t:Date.parse("2026-11-20T10:00:00Z")/1000,p:9999}]};else result={points:url.includes("interval=1mo")?monthly:daily};return {ok:true,json:async()=>result};};
  const source=await readFile(new URL("../static/gold.js",import.meta.url),"utf8");
  class FakeDate extends Date { static now(){return Date.parse("2026-11-20T04:30:00Z");} }
  vm.runInNewContext(source,{document,fetch,AbortSignal,Date:FakeDate,Intl,Math,Number,String,Map,Error,setInterval(){}});
  const settled=()=>new Promise(resolve=>setImmediate(resolve));
  await settled();
  assert.equal(elements.get("gold-price").textContent,"24.76");
  assert.match(elements.get("gold-chart").innerHTML,/gold-line/);
  for(const tick of ["00:00","06:00","12:00","18:00","24:00"])assert.match(elements.get("gold-chart").innerHTML,new RegExp(tick));
  assert.doesNotMatch(elements.get("gold-chart").innerHTML,/>\d,\d{3}/);
  elements.get("gold-chart").pointermove({clientX:900});
  assert.equal(elements.get("gold-detail").textContent,"该时刻暂无行情数据");
  units[1].click();await settled();
  assert.equal(elements.get("gold-price").textContent,"110.00");
  for(const index of [1,2,3,4]){
    ranges[index].click();await settled();
    assert.match(elements.get("gold-chart").innerHTML,/gold-candle/);
    assert.match(elements.get("gold-detail").innerHTML,/开盘/);
    assert.match(elements.get("gold-detail").innerHTML,/最高/);
    assert.match(elements.get("gold-detail").innerHTML,/最低/);
    assert.match(elements.get("gold-detail").innerHTML,/收盘/);
  }
  assert.match(elements.get("gold-detail").innerHTML,/120\.00/);
  assert.match(elements.get("gold-detail").innerHTML,/55\.00/);
  assert.ok(calls.some(url=>url.includes("range=10y&interval=1mo")));
  assert.equal(ranges[4].attributes["aria-pressed"],"true");
});
