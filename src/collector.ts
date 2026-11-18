import { bumpDataRevision, type Env } from "./db.ts";
import { LIVE_ETFS } from "./etf-list.ts";

const QUOTE_URL = "https://qt.gtimg.cn/q=";
const EASTMONEY_LIST_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const EASTMONEY_STOCK_URL = "https://push2.eastmoney.com/api/qt/stock/get";
const SINA_KLINE_URL="https://quotes.sina.cn/cn/api/jsonp.php/=/CN_MarketDataService.getKLineData";
const USER_AGENT = "Mozilla/5.0 (compatible; etftrack/1.0)";

// This smaller basket is deliberately about market-wide broad-index turnover,
// not the complete 34-ETF observation pool used by the daily share collector.
export const LIVE_TURNOVER_CODES=["510300","159915","588000","510330","159919","510050","510500","512100","510310"];
export type TurnoverPoint={time:string;amount_yi:number};
type RawKlineBar={day?:string;amount?:string|number};
type TurnoverEtf={code:string;tcode:string;name:string};

function klineDay(value:unknown){
  const match=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return match?{date:`${match[1]}${match[2]}${match[3]}`,time:`${match[4]}:${match[5]}`} : null;
}
function asAmountYi(value:unknown){const n=Number(value);return Number.isFinite(n)&&n>=0?n/1e8:0;}
function cumulativeBars(bars:RawKlineBar[]){
  const daily=new Map<string,TurnoverPoint[]>();
  for(const bar of bars){const stamp=klineDay(bar.day);if(!stamp)continue;const amount=asAmountYi(bar.amount);if(!amount)continue;const points=daily.get(stamp.date)||[];const prior=points.at(-1)?.amount_yi||0;points.push({time:stamp.time,amount_yi:+(prior+amount).toFixed(6)});daily.set(stamp.date,points);}
  return daily;
}
function mergeLatestQuote(points:TurnoverPoint[],quote:Record<string,unknown>|undefined,date:string){
  const stamp=String(quote?.ts||"");const amount=Number(quote?.amount_yi);
  if(!/^\d{14}$/.test(stamp)||stamp.slice(0,8)!==date||!Number.isFinite(amount)||amount<0)return points;
  const time=`${stamp.slice(8,10)}:${stamp.slice(10,12)}`,last=points.at(-1);
  const inSession=(time>="09:30"&&time<="11:30")||(time>="13:00"&&time<="15:00");
  // Tencent can continue publishing a timestamp after close. It must not form
  // a false second endpoint at x=15:00, nor replace a valid K-line close.
  if(!inSession||!last||time<last.time||amount<last.amount_yi)return points;
  const next={time,amount_yi:+amount.toFixed(6)};
  return last.time===time?[...points.slice(0,-1),next]:[...points,next];
}
function aggregateTurnover(items:{today:TurnoverPoint[];previous:TurnoverPoint[]}[],key:"today"|"previous"){
  const lookup=new Map<string,number>();
  for(const item of items)for(const point of item[key])lookup.set(point.time,+(lookup.get(point.time)||0)+point.amount_yi);
  return [...lookup].sort((a,b)=>a[0].localeCompare(b[0])).map(([time,amount_yi])=>({time,amount_yi:+amount_yi.toFixed(6)}));
}
export function buildLiveTurnoverComparison(etfs:TurnoverEtf[],rawBars:Map<string,RawKlineBar[]>,quotes:Map<string,Record<string,unknown>>){
  const parsed=etfs.map(etf=>({etf,daily:cumulativeBars(rawBars.get(etf.code)||[])})).filter(row=>row.daily.size>=2);
  if(!parsed.length)throw new Error("热门 ETF 五分钟成交数据暂不可用");
  let commonDates: string[]|null=null;
  for(const row of parsed){const dates=[...row.daily.keys()];commonDates=commonDates===null?dates:commonDates.filter(date=>dates.includes(date));}
  const dates=(commonDates||[]).sort();
  if(dates.length<2)throw new Error("热门 ETF 暂无两个可对比的共同交易日");
  const previous_date=dates.at(-2)!,date=dates.at(-1)!;
  const items=parsed.map(({etf,daily})=>({
    code:etf.code,tcode:etf.tcode,name:etf.name,previous_date,
    previous:daily.get(previous_date)!,today:mergeLatestQuote(daily.get(date)!,quotes.get(etf.code),date),
  }));
  return {date,previous_date,default_codes:items.map(item=>item.code),comparison_count:items.length,items,
    aggregate:{today:aggregateTurnover(items,"today"),previous:aggregateTurnover(items,"previous")}};
}
async function fetchSinaKlines(etf:TurnoverEtf){
  const params=new URLSearchParams({symbol:etf.tcode,scale:"5",ma:"5",datalen:"120"});
  const raw=await getText(`${SINA_KLINE_URL}?${params}`,"https://finance.sina.com.cn/",12000);
  const start=raw.indexOf("=("),end=raw.lastIndexOf(")");
  if(start<0||end<=start)throw new Error(`${etf.code} 新浪 K 线响应格式无法识别`);
  const value=JSON.parse(raw.slice(start+2,end));if(!Array.isArray(value))throw new Error(`${etf.code} 新浪 K 线没有返回数组`);
  return [etf.code,value as RawKlineBar[]] as const;
}
export async function fetchLiveTurnoverComparison(){
  const etfs=LIVE_TURNOVER_CODES.map(code=>LIVE_ETFS.find(item=>item.code===code)).filter((item):item is typeof LIVE_ETFS[number]=>Boolean(item));
  if(etfs.length!==LIVE_TURNOVER_CODES.length)throw new Error("热门 ETF 名单配置不完整");
  const [raw,entries]=await Promise.all([
    getText(QUOTE_URL+etfs.map(item=>item.tcode).join(",")),
    Promise.all(Array.from({length:Math.ceil(etfs.length/5)},(_,i)=>Promise.all(etfs.slice(i*5,i*5+5).map(fetchSinaKlines)))).then(groups=>groups.flat()),
  ]);
  const result=buildLiveTurnoverComparison(etfs, new Map(entries), decodeTencent(raw));
  const newest=result.items.flatMap(item=>item.today).map(point=>point.time).sort().at(-1)||"—";
  return {...result,time:newest,source:"新浪公开五分钟 K 线 + 腾讯公开行情",note:"默认合计为 9 只热门宽基 ETF；当日曲线末点以腾讯实时累计成交额补齐。"};
}

export function shareRetryDates(tradeDate:string,currentAlreadyComplete:boolean,pendingDates:string[]){
  // Retry the newest gaps first. Old bootstrap dates must never starve the
  // previous session, which is what users actually look at.
  const unique=[...new Set(pendingDates)].filter(Boolean).filter(date=>date!==tradeDate).sort().reverse();
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

function eastmoneySecid(etf:{code:string;tcode:string}){
  return `${etf.tcode.startsWith("sh")?"1":"0"}.${etf.code}`;
}
function eastmoneyTime(seconds:number){
  if(!Number.isFinite(seconds)||seconds<=0)return "";
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date(seconds*1000));
  const get=(type:string)=>parts.find(part=>part.type===type)?.value||"";
  const hour=get("hour")==="24"?"00":get("hour");
  return `${get("year")}${get("month")}${get("day")}${hour}${get("minute")}${get("second")}`;
}
export async function fetchEastmoneyQuotes(etfs:{code:string;tcode:string}[]){
  const params=new URLSearchParams({fltt:"2",secids:etfs.map(eastmoneySecid).join(","),
    fields:"f2,f3,f5,f6,f12,f14,f18,f20,f124"});
  const body=JSON.parse(await getText(`${EASTMONEY_LIST_URL}?${params}`,"https://quote.eastmoney.com/"));
  const diff=body?.data?.diff;
  if(!Array.isArray(diff)||!diff.length)throw new Error("东方财富行情未返回数据");
  const quotes=new Map<string,Record<string,unknown>>();
  for(const row of diff){
    const code=String(row.f12||""),price=Number(row.f2),ts=eastmoneyTime(Number(row.f124));
    if(!code||!Number.isFinite(price)||price<=0||ts.length<14)continue;
    quotes.set(code,{code,name:String(row.f14||""),price,prev_close:Number(row.f18)||0,
      volume_lots:Number(row.f5)||0,outer_lots:0,inner_lots:0,date:ts.slice(0,8),ts,
      pct:Number(row.f3)||0,amount_yi:(Number(row.f6)||0)/1e8,turnover:0,
      mktcap_yi:(Number(row.f20)||0)/1e8,shares:0});
  }
  return quotes;
}
export async function fetchEastmoneyShares(code:string,tcode:string){
  const params=new URLSearchParams({secid:`${tcode.startsWith("sh")?"1":"0"}.${code}`,fields:"f84"});
  try{
    const body=JSON.parse(await getText(`${EASTMONEY_STOCK_URL}?${params}`,"https://quote.eastmoney.com/",7000));
    const shares=Number(body?.data?.f84);
    return Number.isFinite(shares)&&shares>0?shares:null;
  }catch{return null;}
}
export async function fetchScheduledQuotes(etfs:{code:string;tcode:string;group_name?:string}[]){
  const core=etfs.filter(etf=>etf.group_name==="core");
  const usable=(quotes:Map<string,Record<string,unknown>>)=>{
    if(core.some(etf=>!quotes.has(etf.code)))return false;
    const dates=new Set(core.map(etf=>String(quotes.get(etf.code)?.date||"")));
    return dates.size===1&&Boolean([...dates][0]);
  };
  try{
    const quotes=decodeTencent(await getText(QUOTE_URL+etfs.map(etf=>etf.tcode).join(",")));
    if(!usable(quotes))throw new Error("腾讯行情覆盖不完整或日期不一致");
    return {quotes,source:"腾讯公开行情"};
  }catch(error){
    console.warn("Tencent quotes unavailable; falling back to Eastmoney",error);
    const quotes=await fetchEastmoneyQuotes(etfs);
    if(!usable(quotes))throw new Error("东方财富行情覆盖不完整或日期不一致");
    return {quotes,source:"东方财富行情兜底"};
  }
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
function previousWeekday(date:string){
  const value=new Date(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T00:00:00Z`);
  do{value.setUTCDate(value.getUTCDate()-1);}while(value.getUTCDay()===0||value.getUTCDay()===6);
  return value.toISOString().slice(0,10).replaceAll("-","");
}
export async function collectConfirmedDaily(env:Env, timestamp:number){
  const started=new Date(timestamp).toISOString(),scheduledDate=shanghaiDate(timestamp);
  const run=async(status:string,message:string,date=scheduledDate)=>env.DB.prepare("INSERT INTO collection_runs(started_at,finished_at,status,trade_date,message,source) VALUES(?,?,?,?,?,?)").bind(started,new Date().toISOString(),status,date,message,"Cloudflare Worker Cron").run();
  try{
    const {results:etfs=[]}=await env.DB.prepare("SELECT code,tcode,name,group_name FROM etfs ORDER BY code").all<{code:string;tcode:string;name:string;group_name:string}>();
    const {quotes,source:quoteSource}=await fetchScheduledQuotes(etfs);
    const core=etfs.filter(e=>e.group_name==="core");
    if(core.some(e=>!quotes.has(e.code)))throw new Error("未获取到完整的核心 ETF 行情");
    const quoteDates=new Set(core.map(e=>String(quotes.get(e.code)!.date)));
    if(quoteDates.size!==1)throw new Error("核心 ETF 行情日期不一致");
    // A morning retry runs on the next calendar day while Tencent still reports
    // the previous trading session. Use the quote's trading date for all rows.
    const date=[...quoteDates][0],dateISO=`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
    // The 13:30 retry runs while the market is still open. Only quotes whose
    // clocks have all reached 15:00 may be persisted as the session snapshot/close.
    const marketClosed=core.every(e=>String(quotes.get(e.code)?.ts||"").slice(8,12)>="1500");
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
      ORDER BY s.trade_date DESC LIMIT 30`)
      .bind(date).all<{trade_date:string}>();
    // Workers Free allows 50 external subrequests per invocation. One quote
    // request plus two dates × (one SSE + up to fourteen SZSE requests) = 31.
    // The 13:30 slot has no current-session official shares yet, but it must
    // still retry the previous session even if its snapshot row is missing.
    const previousSession=marketClosed?null:(await env.DB.prepare(
      "SELECT MAX(trade_date) AS d FROM daily_snapshots WHERE trade_date<?",
    ).bind(date).first<{d:string|null}>())?.d||null;
    const pendingDates=(pending.results||[]).map(row=>row.trade_date);
    // Always include the previous weekday, even when its snapshot row is
    // missing. With newest-first retries, this protects the session users
    // look at from being starved by old bootstrap gaps.
    for(const day of [previousSession,previousWeekday(date)]){
      if(day&&!pendingDates.includes(day))pendingDates.push(day);
    }
    const retryDates=shareRetryDates(date,marketClosed?currentAlreadyComplete:true,pendingDates);
    const newOfficialByDate=new Map<string,Map<string,{shares:number;source:string}>>();
    const existingByDate=new Map<string,Set<string>>();
    const coverageByDate=new Map<string,number>();
    const sourceErrors:string[]=[];
    for(const retryDate of retryDates){
      const retryISO=`${retryDate.slice(0,4)}-${retryDate.slice(4,6)}-${retryDate.slice(6,8)}`;
      const existing=await env.DB.prepare("SELECT code FROM share_history WHERE trade_date=? AND source IN ('上交所 ETF 规模披露','深交所 ETF 规模披露')")
        .bind(retryDate).all<{code:string}>();
      existingByDate.set(retryDate,new Set((existing.results||[]).map(row=>row.code)));
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
    const full=marketClosed&&currentCoverageCount===core.length;
    // A single ETF can stay undisclosed for days. Fill the current session's
    // remaining core codes from Eastmoney fund shares, marked as a fallback so
    // a later exchange disclosure can overwrite them.
    const fallbackRows:{code:string;shares:number}[]=[];
    if(marketClosed&&currentCoverageCount<core.length){
      const officialCodes=new Set<string>([...(existingByDate.get(date)||[]),...(newOfficialByDate.get(date)?.keys()||[])]);
      const missing=core.filter(etf=>!officialCodes.has(etf.code)).slice(0,10);
      const fetched=await Promise.all(missing.map(async etf=>({code:etf.code,shares:await fetchEastmoneyShares(etf.code,etf.tcode)})));
      for(const item of fetched)if(item.shares)fallbackRows.push({code:item.code,shares:item.shares});
    }
    const stmts=[];
    for(const [retryDate,rows] of newOfficialByDate){for(const [code,x] of rows)stmts.push(env.DB.prepare(`INSERT INTO share_history(trade_date,code,shares,observed_at,source) VALUES(?,?,?,?,?)
      ON CONFLICT(trade_date,code) DO UPDATE SET shares=excluded.shares,observed_at=excluded.observed_at,source=excluded.source`)
      .bind(retryDate,code,x.shares,new Date().toISOString(),x.source));}
    for(const row of fallbackRows)stmts.push(env.DB.prepare(`INSERT INTO share_history(trade_date,code,shares,observed_at,source) VALUES(?,?,?,?,?)
      ON CONFLICT(trade_date,code) DO UPDATE SET shares=excluded.shares,observed_at=excluded.observed_at,source=excluded.source
      WHERE share_history.source NOT IN ('上交所 ETF 规模披露','深交所 ETF 规模披露')`)
      .bind(date,row.code,row.shares,new Date().toISOString(),"东方财富份额兜底"));
    if(!marketClosed&&previousSession){
      // Intraday quotes carry the previous session's close. Fill a missing
      // daily_closes row so yesterday's money estimate survives even if both
      // post-close slots failed.
      for(const etf of etfs){const q=quotes.get(etf.code),price=Number(q?.prev_close||0);
        if(!q||price<=0)continue;
        stmts.push(env.DB.prepare(`INSERT INTO daily_closes(trade_date,code,close_price,volume_lots,turnover_yi,source)
          VALUES(?,?,?,?,?,?) ON CONFLICT(trade_date,code) DO NOTHING`)
          .bind(previousSession,etf.code,price,null,null,"腾讯前收盘回补"));
      }
    }
    if(marketClosed){
      const prevRows=await env.DB.prepare(`SELECT s.code,s.shares FROM share_history s JOIN (
        SELECT code,MAX(trade_date) AS trade_date FROM share_history
        WHERE trade_date<? AND source <> '腾讯行情份额字段' GROUP BY code
      ) p ON p.code=s.code AND p.trade_date=s.trade_date WHERE s.source <> '腾讯行情份额字段'`).bind(date).all<{code:string;shares:number}>();
      const previous=new Map((prevRows.results||[]).map(r=>[r.code,Number(r.shares)]));
      const [existingSnapshots,existingActivity]=await Promise.all([
        env.DB.prepare("SELECT code FROM daily_snapshots WHERE trade_date=?").bind(date).all<{code:string}>(),
        env.DB.prepare("SELECT code FROM daily_activity WHERE trade_date=?").bind(date).all<{code:string}>(),
      ]);
      const snapshotMissing=new Set(missingEtfsForDate(etfs,existingSnapshots.results||[]).map(e=>e.code));
      const activityMissing=new Set(missingEtfsForDate(etfs,existingActivity.results||[]).map(e=>e.code));
      for(const etf of etfs){const q=quotes.get(etf.code);if(!q)continue;const old=previous.get(etf.code);const payload={...q,prev_shares:old??null,prev_share_date:null,day_progress:1};
        // A quote captured after the close is the only complete same-day price
        // available to this Worker run. Persist it before tomorrow's snapshot
        // becomes the latest one; otherwise yesterday's money estimate would
        // lose its price and degrade to a dash in the historical table.
        if(Number(q.price)>0)stmts.push(env.DB.prepare(`INSERT INTO daily_closes(trade_date,code,close_price,volume_lots,turnover_yi,source)
          VALUES(?,?,?,?,?,?) ON CONFLICT(trade_date,code) DO UPDATE SET
            close_price=excluded.close_price,volume_lots=excluded.volume_lots,
            turnover_yi=excluded.turnover_yi,source=excluded.source`)
          .bind(date,etf.code,q.price,q.volume_lots,q.amount_yi,quoteSource==="腾讯公开行情"?"腾讯收盘行情":"东方财富收盘行情"));
        if(snapshotMissing.has(etf.code))stmts.push(env.DB.prepare("INSERT OR IGNORE INTO daily_snapshots(trade_date,code,payload_json,source_ts,source) VALUES(?,?,?,?,?)").bind(date,etf.code,JSON.stringify(payload),String(q.ts),quoteSource));
        if(activityMissing.has(etf.code))stmts.push(env.DB.prepare("INSERT OR IGNORE INTO daily_activity(trade_date,code,amount_yi,volume_lots,shape_json,tail_ratio,complete) VALUES(?,?,?,?,?,?,?)").bind(date,etf.code,q.amount_yi,q.volume_lots,null,null,1));
      }
    }
    for(let i=0;i<stmts.length;i+=80)await env.DB.batch(stmts.slice(i,i+80));
    const coverage=currentCoverageCount;
    const sourceNote=quoteSource==="腾讯公开行情"?"":`（行情源 ${quoteSource}）`;
    const fallbackNote=fallbackRows.length?`；东方财富兜底 ${fallbackRows.length} 只`:"";
    const message=marketClosed
      ?(full?`已采集 ${core.length} 只核心 ETF 行情与官方份额${sourceNote}`:`已采集行情${sourceNote}；官方份额未齐（${coverage}/${core.length}）${fallbackNote}，${sourceErrors.length?"数据源暂时超时；":""}后续定时继续补采`)
      :`盘中检查完成；未写入盘中快照${retryDates.length?`，已补采 ${retryDates.length} 个历史日期`:""}`;
    await run("success",message,date);
    // Invalidate the pre-computed API payloads and their edge-cache keys.
    await bumpDataRevision(env.DB);
    return {status:"success",trade_date:date,confirmed_shares:full,coverage,core_count:core.length,source_errors:sourceErrors.slice(0,5)};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    // Record the failure and invalidate the API cache so the page shows it
    // immediately instead of keeping the last successful run forever.
    try{await run("failed",message);}catch{}
    try{await bumpDataRevision(env.DB);}catch{}
    throw error;
  }
}
