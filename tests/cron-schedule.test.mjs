import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Cloudflare schedules run at the intended Beijing times without Sunday or Friday gaps", async () => {
  const config=JSON.parse(await readFile(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
  const crons=config.triggers.crons;
  assert.equal(crons.length,4);
  const weekdays=["SUN","MON","TUE","WED","THU","FRI","SAT"];
  function fires(at){
    const utc=new Date(at),day=weekdays[utc.getUTCDay()];
    return crons.filter(expr=>{
      const [minute,hour,, ,days]=expr.split(" ");
      const allowed=days==="MON-FRI"?["MON","TUE","WED","THU","FRI"]:days==="MON-SAT"?["MON","TUE","WED","THU","FRI","SAT"]:[];
      return Number(minute)===utc.getUTCMinutes()&&hour.split(",").map(Number).includes(utc.getUTCHours())&&allowed.includes(day);
    }).length;
  }
  // Thursday session, including Friday morning retries.
  for(const time of ["2026-11-19T18:00:00+08:00","2026-11-19T21:30:00+08:00","2026-11-19T22:30:00+08:00","2026-11-19T23:15:00+08:00","2026-11-20T00:30:00+08:00","2026-11-20T06:30:00+08:00","2026-11-20T08:30:00+08:00","2026-11-20T13:30:00+08:00"])assert.equal(fires(time),1,time);
  // Friday evening and Saturday morning must also fire exactly once.
  for(const time of ["2026-11-20T18:00:00+08:00","2026-11-20T21:30:00+08:00","2026-11-20T22:30:00+08:00","2026-11-20T23:15:00+08:00","2026-11-21T00:30:00+08:00","2026-11-21T06:30:00+08:00","2026-11-21T08:30:00+08:00","2026-11-21T13:30:00+08:00"])assert.equal(fires(time),1,time);
  for(const time of ["2026-11-22T08:30:00+08:00","2026-11-22T13:30:00+08:00","2026-11-22T18:00:00+08:00","2026-11-22T21:30:00+08:00","2026-11-23T00:30:00+08:00"])assert.equal(fires(time),0,time);
});
