import { loadDashboard, loadFlowDetail, loadPoolStatistics, loadFlowOverview, getDataRevision, type Env } from "./db.ts";
import { cachedPayload } from "./api-cache.ts";
import { collectConfirmedDaily, fetchLiveFlow, fetchLiveTurnoverComparison } from "./collector.ts";
import { fetchShanghaiIndex } from "./shanghai-index.ts";

function json(data:unknown,status=200){return Response.json(data,{status,headers:{"Cache-Control":"no-store"}});}
async function cachedRead(
  request:Request,
  env:Env,
  make:(revision:string)=>Promise<{data:unknown;status?:number}>,
){
  // Historical data only changes after a scheduled collection or a local sync.
  // Put the revision in the edge key so those writes invalidate cached copies,
  // and keep the expensive aggregation in api_cache so a miss costs one D1 row.
  const revision=await getDataRevision(env.DB);
  const url=new URL(request.url),key=new Request(`${url.origin}/__data_cache/v3/${revision}${url.pathname}${url.search}`);
  const cache=caches.default,hit=await cache.match(key);if(hit)return hit;
  const result=await make(revision);
  const response=Response.json(result.data,{status:result.status??200,headers:{"Cache-Control":"public, max-age=3600"}});
  await cache.put(key,response.clone());return response;
}
async function cachedLiveFlow(request:Request){
  const url=new URL(request.url),key=new Request(`${url.origin}/__live_flow_cache/v1`),cache=caches.default;
  const hit=await cache.match(key);if(hit)return hit;
  const response=Response.json(await fetchLiveFlow(),{headers:{"Cache-Control":"public, max-age=12"}});
  await cache.put(key,response.clone());return response;
}
async function cachedLiveTurnover(request:Request){
  const url=new URL(request.url),key=new Request(`${url.origin}/__live_turnover_cache/v2`),cache=caches.default;
  const hit=await cache.match(key);if(hit)return hit;
  const response=Response.json(await fetchLiveTurnoverComparison(),{headers:{"Cache-Control":"public, max-age=20"}});
  await cache.put(key,response.clone());return response;
}
async function cachedShanghaiIndex(request:Request){
  const key=new Request(`${new URL(request.url).origin}/__shanghai_index_cache/v1`),cache=caches.default;
  const hit=await cache.match(key);if(hit)return hit;
  const response=Response.json(await fetchShanghaiIndex(),{headers:{"Cache-Control":"public, max-age=300"}});
  await cache.put(key,response.clone());return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if(url.pathname==="/api/health")return json({ok:true,time:new Date().toISOString()});
      if(url.pathname==="/api/dashboard"&&request.method==="GET")return cachedRead(request,env,async revision=>({
        data:await cachedPayload(env,"dashboard:v2",revision,()=>loadDashboard(env.DB)),
      }));
      if(url.pathname==="/api/pool-stats"&&request.method==="GET"){
        const raw=Number(url.searchParams.get("days")||20),days=Math.min(Math.max(Number.isFinite(raw)?Math.trunc(raw):20,1),240);
        return cachedRead(request,env,async revision=>{
          const rows=await cachedPayload(env,"pool-stats:all",revision,()=>loadPoolStatistics(env.DB,0));
          return {data:{days,rows:days>0?rows.slice(-days):rows}};
        });
      }
      if(url.pathname==="/api/flow-overview"&&request.method==="GET")return cachedRead(request,env,async revision=>({
        data:await cachedPayload(env,"flow-overview",revision,()=>loadFlowOverview(env.DB)),
      }));
      if(url.pathname==="/api/flow-detail"&&request.method==="GET"){
        const date=url.searchParams.get("date")||"";if(!/^\d{8}$/.test(date))return json({error:"日期格式应为 YYYYMMDD"},400);
        return cachedRead(request,env,async revision=>{
          const detail=await cachedPayload(env,`flow-detail:${date}`,revision,()=>loadFlowDetail(env.DB,date));
          return detail.items.length
            ?{data:detail}
            :{data:{error:"所选日期没有份额明细"},status:404};
        });
      }
      if(url.pathname==="/api/live-flow"&&request.method==="GET")return cachedLiveFlow(request);
      if(url.pathname==="/api/live-turnover"&&request.method==="GET")return cachedLiveTurnover(request);
      if(url.pathname==="/api/shanghai-index"&&request.method==="GET")return await cachedShanghaiIndex(request);
      if(url.pathname==="/api/update"&&request.method==="POST"){
        const cached=await cachedLiveFlow(request),flow=await cached.json();return json({status:"success",message:`实时估算已更新 · ${flow.time}`,live_flow:flow});
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
