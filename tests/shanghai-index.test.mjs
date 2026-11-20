import assert from "node:assert/strict";
import test from "node:test";
import {parseIndexRows,fetchShanghaiIndex} from "../src/shanghai-index.ts";

test("parses dated Shanghai Composite open and close points from both sources",()=>{
  const expected=[{date:"20261119",open:3527.3,close:3533.79}];
  assert.deepEqual(parseIndexRows({data:{sh000001:{day:[["2026-11-19","3527.30","3533.79","3540","3500"],["2026-11-20","0","0"]]}}},"tencent"),expected);
  assert.deepEqual(parseIndexRows([{day:"2026-11-19",open:"3527.30",close:"3533.79"}],"sina"),expected);
  assert.throws(()=>parseIndexRows({data:{}},"tencent"));
  assert.throws(()=>parseIndexRows([{day:"2026-11-19",open:null,close:"3533"}],"sina"));
});
test("falls back to Sina when Tencent does not provide valid index data",async()=>{
  const original=globalThis.fetch,requests=[];
  globalThis.fetch=async url=>{requests.push(String(url));return Response.json(requests.length===1?{data:{}}:[{day:"2026-11-19",open:"3527.30",close:"3533.79"}]);};
  try{const result=await fetchShanghaiIndex();assert.equal(result.source,"新浪财经");assert.deepEqual(result.rows,[{date:"20261119",open:3527.3,close:3533.79}]);assert.equal(requests.length,2);}
  finally{globalThis.fetch=original;}
});
