import { bumpDataRevision, type Env } from "./db.ts";
import { LIVE_ETFS } from "./etf-list.ts";

const QUOTE_URL = "https://qt.gtimg.cn/q=";
const USER_AGENT = "Mozilla/5.0 (compatible; etftrack/1.0)";

export function shareRetryDates(tradeDate:string,currentAlreadyComplete:boolean,pendingDates:string[]){
  const unique=[...new Set(pendingDates)].filter(Boolean).filter(date=>date!==tradeDate).sort();
  const limit=currentAlreadyComplete?2:1;
  const selected=unique.slice(0,limit);
  if(!currentAlreadyComplete)selected.push(tradeDate);
  return [...new Set(selected)].sort();
}

export function missingEtfsForDate<T extends {code:string}>(etfs:T[],existingRows:{code:string}[]){
  const existing=new Set(existingRows.map(row=>row.code));
  return etfs.filter(etf=>!existing.has(etf.code));
}

function num(fields: string[], index: number): number {
  const value=Number(fields[index]||0);return Number.isFinite(value)?value:0;
}
function decodeTencent(text: string) {
  const output=new Map<string,Record<string,unknown>>();
  for(const statement of text.split(";")){
    const match=statement.match(/v_(?:sh|sz)(\d{6})="(.*)"/s);if(!match)continue;
    const f=match[2].split("~");if(f.length<73)continue;
    const stamp=f[30]?.trim()||"";if(stamp.length<8)continue;
    output.set(match[1],{code:match[1],name:f[1]?.trim(),price:num(f,3),prev_close:num(f,4),volume_lots:num(f,6),outer_lots:num(f,7),inner_lots:num(f,8),date:stamp.slice(0,8),ts:stamp,pct:num(f,32),amount_yi:num(f,37)/10000,turnover:num(f,38),mktcap_yi:num(f,45),shares:num(f,72)});
  }
  return output;
}
async function getText(url:string,referer="",timeoutMs=18000){
  const response=await fetch(url,{headers:{"User-Agent":USER_AGENT,...(referer?{Referer:referer}:{})},signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`行情源 HTTP ${response.status}`);return response.text();
}

export async function fetchLiveFlow(){
  const results=LIVE_ETFS;
  if(!results.length)throw new Error("重点 ETF 名单为空");
  const raw=await getText(QUOTE_URL+results.map(r=>r.tcode).join(","));
  const quotes=decodeTencent(raw);
  const core=results.filter(r=>r.group_name==="core"),missingCore=core.filter(r=>!quotes.has(r.code));
  if(missingCore.length)throw new Error(`实时行情覆盖不完整，缺少 ${missingCore.length} 只重点 ETF`);
  const coreDates=new Set(core.map(row=>String(quotes.get(row.code)?.date||"")));
  if(coreDates.size!==1||![...coreDates][0])throw new Error("重点 ETF 行情日期不一致，本轮估算暂不更新");
  const tradeDate=[...coreDates][0];
  let buy=0,sell=0,amount=0;const stamps:string[]=[];
  for(const row of core){const q=quotes.get(row.code)!;const a=Math.max(Number(q.amount_yi)||0,0),outer=Math.max(Number(q.outer_lots)||0,0),inner=Math.max(Number(q.inner_lots)||0,0),total=outer+inner,net=total?a*(outer-inner)/total:0;buy+=(a+net)/2;sell+=(a-net)/2;amount+=a;stamps.push(String(q.ts));}
  const time=stamps.sort().at(-1)!;
  const items=results.flatMap(row=>{const quote=quotes.get(row.code);return quote&&String(quote.date)===tradeDate?[{...quote,group:row.group_name}]:[];});
  return {date:tradeDate,time,core_count:core.length,quote_count:items.length,total_count:results.length,items,buy_yi:+buy.toFixed(4),sell_yi:+sell.toFixed(4),net_yi:+(buy-sell).toFixed(4),amount_yi:+amount.toFixed(4),source:"腾讯公开行情内外盘估算"};
}

function shanghaiDate(time:number){return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(time)).replaceAll("-","");}
export async function collectConfirmedDaily(env:Env, timestamp:number){
  const started=new Date(timestamp).toISOString(),scheduledDate=shanghaiDate(timestamp);
  const {results:etfs=[]}=await env.DB.prepare("SELECT code,tcode,name,group_name FROM etfs ORDER BY code").all<{code:string;tcode:string;name:string;group_name:string}>();
  const run=async(status:string,message:string,date=scheduledDate)=>env.DB.prepare("INSERT INTO collection_runs(started_at,finished_at,status,trade_date,message,source) VALUES(?,?,?,?,?,?)").bind(started,new Date().toISOString(),status,date,message,"Cloudflare Worker Cron").run();
  try{
    const raw=await getText(QUOTE_URL+etfs.map(e=>e.tcode).join(","));const quotes=decodeTencent(raw);
    const core=etfs.filter(e=>e.group_name==="core");
    if(core.some(e=>!quotes.has(e.code)))throw new Error("未获取到完整的核心 ETF 行情");
    const quoteDates=new Set(core.map(e=>String(quotes.get(e.code)!.date)));
    if(quoteDates.size!==1)throw new Error("核心 ETF 行情日期不一致");
    // A morning retry runs on the next calendar day while Tencent still reports
    // the previous trading session. Use the quote's trading date for all rows.
    const date=[...quoteDates][0],dateISO=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
    const currentCoverage=await env.DB.prepare(`SELECT COUNT(DISTINCT s.code) AS count FROM share_history s JOIN etfs e ON e.code=s.code
      WHERE s.trade_date=? AND e.group_name='core' AND s.source IN ('上交所 ETF 规模披露','深交所 ETF 规模披露')`)
      .bind(date).first<{count:number}>();
    const currentAlreadyComplete=Number(currentCoverage?.count||0)===core.length;
    const pending=await env.DB.prepare(`SELECT s.trade_date
      FROM daily_snapshots s JOIN etfs e ON e.code=s.code AND e.group_name='core'
      WHERE s.trade_date<? GROUP BY s.trade_date
      HAVING (SELECT COUNT(DISTINCT h.code) FROM share_history h JOIN etfs he ON he.code=h.code
        WHERE h.trade_date=s.trade_date AND he.group_name='core'
          AND h.source IN ('上交所 ETF 规模披露','深交所 ETF 规模披露')) < COUNT(DISTINCT s.code)
      ORDER BY s.trade_date ASC LIMIT 30`)
      .bind(date).all<{trade_date:string}>();
    // Workers Free allows 50 external subrequests per invocation. One quote
    // request plus two dates × (one SSE + up to fourteen SZSE requests) = 31.
    const retryDates=shareRetryDates(date,currentAlreadyComplete,(pending.results||[]).map(row=>row.trade_date));
    const newOfficialByDate=new Map<string,Map<string,{shares:number;source:string}>>();
    const coverageByDate=new Map<string,number>();
    const sourceErrors:string[]=[];
    for(const retryDate of retryDates){
      const retryISO=`${retryDate.slice(0,4)}-${retryDate.slice(4,6)}-${retryDate.slice(6,8)}`;
      const existing=await env.DB.prepare("SELECT code FROM share_history WHERE trade_date=? AND source IN ('上交所 ETF 规模披露','深交所 ETF 规模披露')")
        .bind(retryDate).all<{code:string}>();
      const missing=missingEtfsForDate(core,existing.results||[]);
      const official=new Map<string,{shares:number;source:string}>();
      const sh=missing.filter(e=>e.tcode.startsWith("sh"));
      const sz=missing.filter(e=>e.tcode.startsWith("sz"));
      if(sh.length){
        const params=new URLSearchParams({sqlId:"COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",STAT_DATE:retryISO});
        try{
          const body=JSON.parse(await getText(`https://query.sse.com.cn/commonQuery.do?${params}`,"https://www.sse.com.cn/",7000));
          for(const item of body.result||[]){const code=String(item.SEC_CODE||""),shares=Number(String(item.TOT_VOL||"").replaceAll(",",""))*1e4;if(shares>0&&Number.isFinite(shares)&&sh.some(e=>e.code===code))official.set(code,{shares,source:"上交所 ETF 规模披露"});}
        }catch(error){sourceErrors.push(`上交所 ${retryDate}: ${error instanceof Error?error.message:String(error)}`);}
      }
      for(let i=0;i<sz.length;i+=5){
        await Promise.all(sz.slice(i,i+5).map(async etf=>{
          const params=new URLSearchParams({SHOWTYPE:"JSON",CATALOGID:"scsj_fund_jjgm",TABKEY:"tab1",txtDm:etf.code,txtStart:retryISO,txtEnd:retryISO,jjlb:"ETF",tab1PAGENO:"1"});
          try{
            const payload=JSON.parse(await getText(`https://www.szse.cn/api/report/ShowReport/data?${params}`,"https://www.szse.cn/market/fund/volume/etf/index.html",7000));
            for(const row of payload?.[0]?.data||[]){const d=String(row.size_date||"").replaceAll("-","");const shares=Number(String(row.current_size||0).replaceAll(",",""))*1e4;if(d===retryDate&&shares>0)official.set(etf.code,{shares,source:"深交所 ETF 规模披露"});}
          }catch(error){sourceErrors.push(`深交所 ${etf.code} ${retryDate}: ${error instanceof Error?error.message:String(error)}`);}
        }));
      }
      if(official.size)newOfficialByDate.set(retryDate,official);
      const coverage=missing.length?core.length-missing.length+official.size:core.length;
      coverageByDate.set(retryDate,coverage);
    }
    const currentCoverageCount=coverageByDate.get(date)??Number(currentCoverage?.count||0);
    const full=currentCoverageCount===core.length;
    const prevRows=await env.DB.prepare(`SELECT s.code,s.shares FROM share_history s JOIN (
      SELECT code,MAX(trade_date) AS trade_date FROM share_history
      WHERE trade_date<? AND source <> '腾讯行情份额字段' GROUP BY code
    ) p ON p.code=s.code AND p.trade_date=s.trade_date WHERE s.source <> '腾讯行情份额字段'`).bind(date).all<{code:string;shares:number}>();
    const previous=new Map((prevRows.results||[]).map(r=>[r.code,Number(r.shares)]));
    const stmts=[];
    for(const [retryDate,rows] of newOfficialByDate){for(const [code,x] of rows)stmts.push(env.DB.prepare(`INSERT INTO share_history(trade_date,code,shares,observed_at,source) VALUES(?,?,?,?,?)
      ON CONFLICT(trade_date,code) DO UPDATE SET shares=excluded.shares,observed_at=excluded.observed_at,source=excluded.source`)
      .bind(retryDate,code,x.shares,new Date().toISOString(),x.source));}
    const [existingSnapshots,existingActivity]=await Promise.all([
      env.DB.prepare("SELECT code FROM daily_snapshots WHERE trade_date=?").bind(date).all<{code:string}>(),
      env.DB.prepare("SELECT code FROM daily_activity WHERE trade_date=?").bind(date).all<{code:string}>(),
    ]);
    const snapshotMissing=new Set(missingEtfsForDate(etfs,existingSnapshots.results||[]).map(e=>e.code));
    const activityMissing=new Set(missingEtfsForDate(etfs,existingActivity.results||[]).map(e=>e.code));
    for(const etf of etfs){const q=quotes.get(etf.code);if(!q)continue;const old=previous.get(etf.code);const payload={...q,prev_shares:old??null,prev_share_date:null,day_progress:1};
      if(snapshotMissing.has(etf.code))stmts.push(env.DB.prepare("INSERT OR IGNORE INTO daily_snapshots(trade_date,code,payload_json,source_ts,source) VALUES(?,?,?,?,?)").bind(date,etf.code,JSON.stringify(payload),String(q.ts),"腾讯公开行情"));
      if(activityMissing.has(etf.code))stmts.push(env.DB.prepare("INSERT OR IGNORE INTO daily_activity(trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete) VALUES(?,?,?,?,?,?,?)").bind(date,etf.code,q.amount_yi,q.volume_lots,null,null,1));
    }
    for(let i=0;i<stmts.length;i+=80)await env.DB.batch(stmts.slice(i,i+80));
    const coverage=currentCoverageCount;
    const message=full?`已采集 ${core.length} 只核心 ETF 行情与官方份额`:`已采集行情；官方份额未齐（${coverage}/${core.length}），${sourceErrors.length?"数据源暂时超时；":""}后续定时继续补采`;
    await run("success",message,date);
    // Invalidate the pre-computed API payloads and their edge-cache keys.
    await bumpDataRevision(env.DB);
    return {status:"success",trade_date:date,confirmed_shares:full,coverage,core_count:core.length,source_errors:sourceErrors.slice(0,5)};
  }catch(error){await run("failed",error instanceof Error?error.message:String(error));throw error;}
}
