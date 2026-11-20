import assert from "node:assert/strict";
import test from "node:test";
import {parseIndexRows,fetchShanghaiIndex} from "../src/shanghai-index.ts";

test("parses high, low and prior close for dated index data from both sources",()=>{
  const expected=[{date:"20261118",open:3500,close:3500,high:3520,low:3480,prev_close:null},{date:"20261119",open:3527.3,close:3533.79,high:3540,low:3500,prev_close:3500}];
  const tencent={data:{sh000001:{day:[["2026-11-19","3527.30","3533.79","3540","3500"],["2026-11-18","3500","3500","3520","3480"]]}}};
  const sina=[{day:"2026-11-18",open:"3500",close:"3500",high:"3520",low:"3480"},{day:"2026-11-19",open:"3527.30",close:"3533.79",high:"3540",low:"3500"}];
  assert.deepEqual(parseIndexRows(tencent,"tencent"),expected);
  assert.deepEqual(parseIndexRows(sina,"sina"),expected);
  assert.throws(()=>parseIndexRows({data:{}},"tencent"));
  assert.throws(()=>parseIndexRows([{day:"2026-11-19",close:null}],"sina"));
});
test("missing previous close or invalid high and low are not fabricated",()=>{
  const rows=parseIndexRows([{day:"2026-11-18",close:"0"},{day:"2026-11-19",close:"3500",high:"3400",low:"3300"}],"sina");
  assert.deepEqual(rows,[{date:"20261119",open:null,close:3500,high:null,low:null,prev_close:null}]);
});
test("falls back to Sina when Tencent does not provide valid index data",async()=>{
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async url=>{requests.push(String(url));return Response.json(requests.length===1?{data:{}}:[{day:"2026-11-19",open:"3527.30",close:"3533.79",high:"3540",low:"3500"}]);};
  try{const result=await fetchShanghaiIndex();assert.equal(result.source,"新浪财经");assert.deepEqual(result.rows,[{date:"20261119",open:3527.3,close:3533.79,high:3540,low:3500,prev_close:null}]);assert.equal(requests.length,2);}
  finally{globalThis.fetch=original;}
});
