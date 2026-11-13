import { loadDashboard, loadFlowDetail, loadPoolStatistics, type Env } from "./db.ts";
import { collectConfirmedDaily, fetchLiveFlow } from "./collector.ts";

function json(data:unknown,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store"}});}
async function cachedRead(request:Request,env:Env,make:()=>Promise<unknown>){
  const version=await env.DB.prepare("SELECT COALESCE(MAX(id),0) AS version FROM collection_runs").first<{version:number}>();
  const url=new URL(request.url),key=new Request(`${url.origin}/__data_cache/${version?.version||0}${url.pathname}${url.search}`);
  const cache=caches.default,hit=await cache.match(key);if(hit)return hit;
  const response=Response.json(await make(),{headers:{"Cache-Control":"public, max-age=86400"}});
  await cache.put(key,response.clone());return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if(url.pathname==="/api/health")return json({ok:true,time:new Date().toISOString()});
      if(url.pathname==="/api/dashboard"&&request.method==="GET")return cachedRead(request,env,()=>loadDashboard(env.DB));
      if(url.pathname==="/api/pool-stats"&&request.method==="GET"){
        const raw=Number(url.searchParams.get("days")||20),days=Math.min(Math.max(Number.isFinite(raw)?Math.trunc(raw):20,1),240);
        return cachedRead(request,env,async()=>({days,rows:await loadPoolStatistics(env.DB,days)}));
      }
      if(url.pathname==="/api/flow-detail"&&request.method==="GET"){
        const date=url.searchParams.get("date")||"";if(!/^\d{8}$/.test(date))return json({error:"日期格式应为 YYYYMMDD"},400);
        const detail=await loadFlowDetail(env.DB,date);if(!detail.items.length)return json({error:"所选日期没有份额明细"},404);return json(detail);
      }
      if(url.pathname==="/api/live-flow"&&request.method==="GET")return json(await fetchLiveFlow(env.DB));
      if(url.pathname==="/api/update"&&request.method==="POST"){
        const flow=await fetchLiveFlow(env.DB);return json({status:"success",message:`实时估算已更新 · ${flow.time}`,live_flow:flow});
      }
      if (url.pathname.startsWith("/api/")) return json({error:"Not found"},404);
      return env.ASSETS.fetch(request);
    } catch(error) {
      const message=error instanceof Error?error.message:"Worker 请求失败";
      return json({error:message},url.pathname==="/api/live-flow"||url.pathname==="/api/update"?502:500);
    }
  },
  async scheduled(event:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil(collectConfirmedDaily(env,event.scheduledTime));},
};
