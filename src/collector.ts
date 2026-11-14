import type { Env } from "./db";

const QUOTE_URL = "https://qt.gtimg.cn/q=";
const USER_AGENT = "Mozilla/5.0 (compatible; etftrack/1.0)";

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
async function getText(url:string,referer=""){
  const response=await fetch(url,{headers:{"User-Agent":USER_AGENT,...(referer?{Referer:referer}:{})},signal:AbortSignal.timeout(18000)});
  if(!response.ok)throw new Error(`行情源 HTTP ${response.status}`);return response.text();
}

export async function fetchLiveFlow(db:D1Database){
  const {results=[]}=await db.prepare("SELECT code,tcode,name FROM etfs WHERE group_name='core' ORDER BY code").all<{code:string;tcode:string;name:string}>();
  if(!results.length)throw new Error("重点 ETF 名单为空");
  const raw=await getText(QUOTE_URL+results.map(r=>r.tcode).join(","));
  const quotes=decodeTencent(raw),missing=results.filter(r=>!quotes.has(r.code));
  if(missing.length)throw new Error(`实时行情覆盖不完整，缺少 ${missing.length} 只 ETF`);
  let buy=0,sell=0,amount=0;const stamps:string[]=[];
  for(const row of results){const q=quotes.get(row.code)!;const a=Math.max(Number(q.amount_yi)||0,0),outer=Math.max(Number(q.outer_lots)||0,0),inner=Math.max(Number(q.inner_lots)||0,0),total=outer+inner,net=total?a*(outer-inner)/total:0;buy+=(a+net)/2;sell+=(a-net)/2;amount+=a;stamps.push(String(q.ts));}
  const time=stamps.sort().at(-1)!;
  return {date:time.slice(0,8),time,core_count:results.length,buy_yi:+buy.toFixed(4),sell_yi:+sell.toFixed(4),net_yi:+(buy-sell).toFixed(4),amount_yi:+amount.toFixed(4),source:"腾讯公开行情内外盘估算"};
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
    const complete=await env.DB.prepare(`SELECT s.trade_date FROM share_history s JOIN etfs e ON e.code=s.code
      WHERE e.group_name='core' GROUP BY s.trade_date HAVING COUNT(DISTINCT s.code)=? ORDER BY s.trade_date DESC LIMIT 1`)
      .bind(core.length).first<{trade_date:string}>();
    const pending=await env.DB.prepare("SELECT DISTINCT trade_date FROM daily_snapshots WHERE trade_date>? ORDER BY trade_date DESC LIMIT 5")
      .bind(complete?.trade_date||"00000000").all<{trade_date:string}>();
    // Retry recent incomplete quote dates on every cron run; exchange reports
    // can lag the close or be temporarily unavailable.
    const retryDates=[...new Set([date,...(pending.results||[]).map(row=>row.trade_date)])].sort();
    const officialByDate=new Map<string,Map<string,{shares:number;source:string}>>();
    const sh=core.filter(e=>e.tcode.startsWith("sh"));
    const sz=core.filter(e=>e.tcode.startsWith("sz"));
    for(const retryDate of retryDates){
      const retryISO=`${retryDate.slice(0,4)}-${retryDate.slice(4,6)}-${retryDate.slice(6,8)}`;
      const official=new Map<string,{shares:number;source:string}>();
      if(sh.length){
        const params=new URLSearchParams({sqlId:"COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L",STAT_DATE:retryISO});
        const body=JSON.parse(await getText(`https://query.sse.com.cn/commonQuery.do?${params}`,"https://www.sse.com.cn/"));
        for(const item of body.result||[]){const code=String(item.SEC_CODE||"");if(item.TOT_VOL&&sh.some(e=>e.code===code))official.set(code,{shares:Number(String(item.TOT_VOL).replaceAll(",",""))*1e4,source:"上交所 ETF 规模披露"});}
      }
      for(const etf of sz){
        const params=new URLSearchParams({SHOWTYPE:"JSON",CATALOGID:"scsj_fund_jjgm",TABKEY:"tab1",txtDm:etf.code,txtStart:retryISO,txtEnd:retryISO,jjlb:"ETF",tab1PAGENO:"1"});
        const payload=JSON.parse(await getText(`https://www.szse.cn/api/report/ShowReport/data?${params}`,"https://www.szse.cn/market/fund/volume/etf/index.html"));
        for(const row of payload?.[0]?.data||[]){const d=String(row.size_date||"").replaceAll("-","");const shares=Number(String(row.current_size||0).replaceAll(",",""))*1e4;if(d===retryDate&&shares>0)official.set(etf.code,{shares,source:"深交所 ETF 规模披露"});}
      }
      if(core.every(e=>official.has(e.code)))officialByDate.set(retryDate,official);
    }
    const official=officialByDate.get(date)||new Map<string,{shares:number;source:string}>();
    const full=officialByDate.has(date);
    const prevRows=await env.DB.prepare("SELECT code,shares FROM share_history WHERE trade_date=(SELECT MAX(trade_date) FROM share_history)").all<{code:string;shares:number}>();
    const previous=new Map((prevRows.results||[]).map(r=>[r.code,Number(r.shares)]));
    const stmts=[];
    for(const [retryDate,rows] of officialByDate){for(const etf of core){const x=rows.get(etf.code)!;stmts.push(env.DB.prepare("INSERT OR REPLACE INTO share_history(trade_date,code,shares,observed_at,source) VALUES(?,?,?,?,?)").bind(retryDate,etf.code,x.shares,new Date().toISOString(),x.source));}}
    for(const etf of etfs){const q=quotes.get(etf.code);if(!q)continue;const old=previous.get(etf.code);const payload={...q,prev_shares:old??null,prev_share_date:null,day_progress:1};
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO daily_snapshots(trade_date,code,payload_json,source_ts,source) VALUES(?,?,?,?,?)").bind(date,etf.code,JSON.stringify(payload),String(q.ts),"腾讯公开行情"));
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO daily_activity(trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete) VALUES(?,?,?,?,?,?,?)").bind(date,etf.code,q.amount_yi,q.volume_lots,null,null,1));
    }
    for(let i=0;i<stmts.length;i+=80)await env.DB.batch(stmts.slice(i,i+80));
    await run("success",full?`已采集 ${core.length} 只核心 ETF 行情与官方份额`:`已采集行情；官方份额未齐（${official.size}/${core.length}），下次定时继续补采`,date);
    return {status:"success",trade_date:date,confirmed_shares:full,coverage:official.size,core_count:core.length};
  }catch(error){await run("failed",error instanceof Error?error.message:String(error));throw error;}
}
