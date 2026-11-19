export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Show a date as soon as any core ETF has a share row. The UI always carries
// the coverage count, so a partial day is visible instead of silently absent.
export function hasUsableShareCoverage(expected:number, received:number){
  return expected > 0 && received > 0;
}

export async function getDataRevision(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key='data_revision'")
    .first<{ value: string }>();
  return row?.value ?? "0";
}

export async function bumpDataRevision(db: D1Database): Promise<void> {
  await db.prepare(
    `INSERT INTO app_meta(key,value) VALUES('data_revision',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).bind(new Date().toISOString()).run();
}

export async function loadDashboard(db: D1Database) {
  const latestRow = await db.prepare("SELECT MAX(trade_date) AS d FROM daily_snapshots").first<{ d: string | null }>();
  const latest = latestRow?.d ?? null;
  const rows = latest ? await db.prepare(`
    SELECT e.code,e.tcode,e.name,e.index_name,e.group_name,e.huijin_yi,
           s.payload_json,s.source_ts,s.source
    FROM daily_snapshots s JOIN etfs e ON e.code=s.code WHERE s.trade_date=?
    ORDER BY CASE e.group_name WHEN 'core' THEN 0 ELSE 1 END, COALESCE(e.huijin_yi,0) DESC,e.code
  `).bind(latest).all<Record<string, unknown>>() : { results: [] };
  const etfs = (rows.results ?? []).map(row => {
    const item = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    Object.assign(item, { code: row.code, tcode: row.tcode, name: row.name, index: row.index_name,
      group: row.group_name, huijin_yi: row.huijin_yi, source_ts: row.source_ts, source_name: row.source });
    if (item.price && item.shares && item.prev_shares) {
      item.subscr_net_yi = Math.round((Number(item.shares)-Number(item.prev_shares))*Number(item.price)/1e6)/100;
    }
    return item;
  });
  // Worker snapshots contain quotes only. Reconstruct chart history and the
  // prior-session baseline from persisted daily activity for every snapshot.
  if (latest) {
    const activity = await db.prepare(`WITH ranked AS (
      SELECT code,trade_date,amount_yi,volume_lots,
        ROW_NUMBER() OVER (PARTITION BY code ORDER BY trade_date DESC) AS history_rank,
        CASE WHEN trade_date < ? AND amount_yi IS NOT NULL THEN
          SUM(CASE WHEN trade_date < ? AND amount_yi IS NOT NULL THEN 1 ELSE 0 END)
          OVER (PARTITION BY code ORDER BY trade_date DESC) END AS average_rank
      FROM daily_activity WHERE trade_date <= ?
    ) SELECT * FROM ranked WHERE history_rank <= 30 OR average_rank <= 20`)
      .bind(latest,latest,latest).all<{code:string;trade_date:string;amount_yi:number|null;volume_lots:number|null;history_rank:number;average_rank:number|null}>();
    const byCode = new Map<string,typeof activity.results>();
    for (const row of activity.results ?? []) {
      if (!byCode.has(row.code)) byCode.set(row.code,[]);
      byCode.get(row.code)!.push(row);
    }
    for (const item of etfs) {
      const history=byCode.get(String(item.code)) ?? [];
      item.hist=history.filter(row=>row.history_rank<=30).sort((a,b)=>a.trade_date.localeCompare(b.trade_date))
        .map(row=>({date:row.trade_date,amount_yi:row.amount_yi,volume_lots:row.volume_lots}));
      const baseline=history.filter(row=>row.average_rank!=null && row.average_rank<=20 && row.amount_yi!=null);
      item.avg20_yi=baseline.length ? baseline.reduce((sum,row)=>sum+Number(row.amount_yi),0)/baseline.length : 0;
    }
  }
  const core = etfs.filter(item => item.group === "core");
  const sum = (key: string) => core.reduce((total, item) => total + Number(item[key] || 0), 0);
  const amount_yi = sum("amount_yi"), avg20_yi = sum("avg20_yi"), flow_yi = sum("subscr_net_yi");
  const cap = sum("mktcap_yi");
  const weighted_pct = cap ? core.reduce((total, item) => total + Number(item.pct || 0)*Number(item.mktcap_yi || 0), 0)/cap : 0;
  const active_net_yi = core.reduce((total, item) => {
    const outer=Number(item.outer_lots||0),inner=Number(item.inner_lots||0),amount=Number(item.amount_yi||0);
    return total+(outer-inner)/Math.max(outer+inner,1)*amount;
  },0);
  const progress = Math.min(1,...core.map(item => Number(item.day_progress || 1)));
  const ratio = avg20_yi*progress ? amount_yi/(avg20_yi*progress) : 0;
  const verdict = ratio>=1.8 && flow_yi>0 ? "成交放量，份额估算偏流入" : ratio>=1.3 ? "成交较活跃，方向仍需观察" : "暂未看到明显放量";
  const history = await db.prepare(`
    SELECT h.trade_date,h.code,h.shares,h.source,e.group_name FROM share_history h JOIN etfs e ON e.code=h.code
    WHERE e.group_name='core' AND h.source <> '腾讯行情份额字段' ORDER BY h.trade_date,h.code
  `).all<{trade_date:string;code:string;shares:number;source:string;group_name:string}>();
  const codes = core.map(item => String(item.code));
  const byDate = new Map<string,Map<string,number>>(), unconfirmed = new Set<string>(), firstSeen = new Map<string,string>();
  const fallbackByDate = new Map<string,Set<string>>();
  for (const row of history.results ?? []) {
    if (row.source === "腾讯行情份额字段") unconfirmed.add(row.trade_date);
    if (!firstSeen.has(row.code)) firstSeen.set(row.code,row.trade_date);
    if (!byDate.has(row.trade_date)) byDate.set(row.trade_date,new Map());
    byDate.get(row.trade_date)!.set(row.code,Number(row.shares));
    if (row.source.includes("兜底")) {
      if (!fallbackByDate.has(row.trade_date)) fallbackByDate.set(row.trade_date,new Set());
      fallbackByDate.get(row.trade_date)!.add(row.code);
    }
  }
  // Prefer the published/fallback share history for the latest snapshot so the
  // table does not keep showing Tencent's quote share when official data exists.
  if(latest)for(const item of etfs){const share=byDate.get(latest)?.get(String(item.code));if(share!=null){item.shares=share;item.shares_yi=share/1e8;}}
  const previous=new Map<string,number>(),changes=new Map<string,Map<string,number>>();
  for(const row of history.results??[]){const old=previous.get(row.code),shares=Number(row.shares);if(old!==undefined){if(!changes.has(row.trade_date))changes.set(row.trade_date,new Map());changes.get(row.trade_date)!.set(row.code,(shares-old)/1e8);}previous.set(row.code,shares);}
  const pool = [...byDate.keys()].sort().flatMap(date => {
    if (unconfirmed.has(date)) return [];
    const shares=byDate.get(date)!;
    const active=codes.filter(code=>(firstSeen.get(code)||date)<=date),dailyChanges=changes.get(date);
    const covered=active.filter(code=>shares.has(code)&&dailyChanges?.has(code));
    if (!hasUsableShareCoverage(active.length,covered.length)) return [];
    const total=covered.reduce((n,code)=>n+shares.get(code)!,0),delta=covered.reduce((n,code)=>n+dailyChanges!.get(code)!,0);
    const fallbackCount=covered.filter(code=>fallbackByDate.get(date)?.has(code)).length;
    return [{date,shares_yi:total/1e8,delta_yi:delta,core_count:covered.length,basket_count:active.length,fallback_count:fallbackCount}];
  });
  const latestOfficial=new Set<string>(),latestFallback=new Set<string>();
  for(const row of history.results??[])if(row.trade_date===latest){
    if(row.source==="上交所 ETF 规模披露"||row.source==="深交所 ETF 规模披露")latestOfficial.add(row.code);
    if(row.source.includes("兜底"))latestFallback.add(row.code);
  }
  const latest_run = await db.prepare("SELECT id,started_at,finished_at,status,trade_date,message,source FROM collection_runs ORDER BY id DESC LIMIT 1").first();
  const metaRows = await db.prepare("SELECT key,value FROM app_meta").all<{key:string;value:string}>();
  const meta = Object.fromEntries((metaRows.results ?? []).map(row => [row.key,row.value]));
  return {
    runtime: "cloudflare", generated_at: new Date().toISOString(), trade_date: latest,
    source: meta.source || "腾讯行情公开接口；新浪 5 分钟 K 线",
    huijin_basis: meta.huijin_basis || "2025 年报历史披露口径，仅为历史标签",
    prev_share_date: meta.prev_share_date || null, latest_run,
    latest_share_coverage: {date:latest,covered:latestOfficial.size,basket:core.length,fallback:latestFallback.size},
    summary: { amount_yi,avg20_yi,ratio,flow_yi,active_net_yi,weighted_pct,progress,verdict,core_count:core.length,total_count:etfs.length },
    etfs,history:{pool},
  };
}

export async function loadFlowDetail(db: D1Database, date: string) {
  const [{results=[]},coreCount] = await Promise.all([db.prepare(`
    SELECT e.code,e.name,h.shares,prev.shares AS prev_shares,a.amount_yi,a.volume_lots,h.source,c.close_price,snap.payload_json AS snapshot_payload
    FROM etfs e JOIN share_history h ON h.code=e.code AND h.trade_date=? AND h.source <> '腾讯行情份额字段'
    LEFT JOIN share_history prev ON prev.code=e.code AND prev.trade_date=(
      SELECT MAX(p.trade_date) FROM share_history p WHERE p.code=e.code AND p.trade_date<h.trade_date AND p.source <> '腾讯行情份额字段')
    LEFT JOIN daily_activity a ON a.code=e.code AND a.trade_date=h.trade_date
    LEFT JOIN daily_closes c ON c.code=e.code AND c.trade_date=h.trade_date
    LEFT JOIN daily_snapshots snap ON snap.code=e.code AND snap.trade_date=h.trade_date
    WHERE e.group_name='core' ORDER BY e.code
  `).bind(date).all<Record<string,unknown>>(),db.prepare(`SELECT COUNT(*) AS count FROM etfs e
    WHERE e.group_name='core' AND EXISTS (
      SELECT 1 FROM share_history h WHERE h.code=e.code
        AND h.source <> '腾讯行情份额字段' AND h.trade_date<=?)`).bind(date).first<{count:number}>()]);
  const basket_count=Number(coreCount?.count||results.length);
  if (!hasUsableShareCoverage(basket_count,results.length)||results.some(row=>row.source==="腾讯行情份额字段")) return {date,core_count:results.length,basket_count,fallback_count:0,items:[],buy_yi:0,sell_yi:0,net_yi:0,volume_yi:null,amount_yi:null,volume_coverage:0,amount_coverage:0};
  let buy=0,sell=0,volume=0,amount=0,volume_coverage=0,amount_coverage=0;
  let buy_amount=0,sell_amount=0,buy_count=0,sell_count=0,buy_amount_coverage=0,sell_amount_coverage=0;
  const items=results.map(row=>{
    const delta=row.prev_shares==null?null:(Number(row.shares)-Number(row.prev_shares))/1e8;
    const volume_yi=row.volume_lots==null?null:Number(row.volume_lots)*100/1e8;
    const amount_yi=row.amount_yi==null?null:Number(row.amount_yi);
    let close_price=row.close_price==null?null:Number(row.close_price);
    if(close_price==null&&typeof row.snapshot_payload==="string")try{const payload=JSON.parse(row.snapshot_payload) as Record<string,unknown>;close_price=Number(payload.price)||null;}catch{}
    const estimated_amount_yi=delta!==null&&close_price!==null?delta*close_price:null;
    if(delta!==null){if(delta>0){buy+=delta;buy_count++;if(estimated_amount_yi!==null){buy_amount+=estimated_amount_yi;buy_amount_coverage++;}}else if(delta<0){sell+=Math.abs(delta);sell_count++;if(estimated_amount_yi!==null){sell_amount+=Math.abs(estimated_amount_yi);sell_amount_coverage++;}}}
    if(volume_yi!==null){volume+=volume_yi;volume_coverage++;}
    if(amount_yi!==null){amount+=amount_yi;amount_coverage++;}
    return {code:row.code,name:row.name,delta_yi:delta,buy_amount_yi:estimated_amount_yi===null?null:Math.max(estimated_amount_yi,0),
      sell_amount_yi:estimated_amount_yi===null?null:Math.abs(Math.min(estimated_amount_yi,0)),volume_yi,amount_yi,source:row.source};
  });
  const fallback_count=items.filter(item=>String(item.source).includes("兜底")).length;
  return {date,core_count:items.length,basket_count,fallback_count,items,buy_yi:buy,sell_yi:sell,buy_amount_yi:buy_amount,sell_amount_yi:sell_amount,
    buy_count,sell_count,buy_amount_coverage,sell_amount_coverage,net_yi:buy-sell,
    volume_yi:volume_coverage?volume:null,amount_yi:amount_coverage?amount:null,volume_coverage,amount_coverage};
}

export async function loadPoolStatistics(db: D1Database, days: number) {
  const [coreRows,histRows,activityRows,closeRows,snapshotRows] = await Promise.all([
    db.prepare("SELECT code FROM etfs WHERE group_name='core' ORDER BY code").all<{code:string}>(),
    db.prepare("SELECT trade_date,code,shares,source FROM share_history WHERE code IN (SELECT code FROM etfs WHERE group_name='core') AND source <> '腾讯行情份额字段' ORDER BY trade_date,code").all<{trade_date:string;code:string;shares:number;source:string}>(),
    db.prepare("SELECT trade_date,code,amount_yi,volume_lots FROM daily_activity WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date").all<{trade_date:string;code:string;amount_yi:number|null;volume_lots:number|null}>(),
    db.prepare("SELECT trade_date,code,close_price FROM daily_closes WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date").all<{trade_date:string;code:string;close_price:number}>(),
    db.prepare("SELECT trade_date,code,payload_json FROM daily_snapshots WHERE trade_date=(SELECT MAX(trade_date) FROM daily_snapshots)").all<{trade_date:string;code:string;payload_json:string}>(),
  ]);
  const codes=(coreRows.results??[]).map(row=>row.code), changes=new Map<string,Map<string,number>>(), unconfirmed=new Set<string>(), prev=new Map<string,number>(), firstSeen=new Map<string,string>(), fallback=new Map<string,Set<string>>();
  for(const row of histRows.results??[]){if(row.source==="腾讯行情份额字段")unconfirmed.add(row.trade_date);if(!firstSeen.has(row.code))firstSeen.set(row.code,row.trade_date);if(prev.has(row.code)){if(!changes.has(row.trade_date))changes.set(row.trade_date,new Map());changes.get(row.trade_date)!.set(row.code,(Number(row.shares)-prev.get(row.code)!)/1e8);}if(row.source.includes("兜底")){if(!fallback.has(row.trade_date))fallback.set(row.trade_date,new Set());fallback.get(row.trade_date)!.add(row.code);}prev.set(row.code,Number(row.shares));}
  const activity=new Map<string,Map<string,typeof activityRows.results[number]>>();for(const row of activityRows.results??[]){if(!activity.has(row.trade_date))activity.set(row.trade_date,new Map());activity.get(row.trade_date)!.set(row.code,row);}
  const prices=new Map<string,Map<string,number>>();for(const row of closeRows.results??[]){if(!prices.has(row.trade_date))prices.set(row.trade_date,new Map());prices.get(row.trade_date)!.set(row.code,Number(row.close_price));}
  const latest=(snapshotRows.results??[])[0]?.trade_date;const live=new Map<string,number>();for(const row of snapshotRows.results??[]){const p=JSON.parse(row.payload_json);if(p.price)live.set(row.code,Number(p.price));}
  const amountHistory:number[]=[],out=[];
  for(const date of [...changes.keys()].sort()){
    if(unconfirmed.has(date))continue;const delta=changes.get(date)!,active=codes.filter(c=>(firstSeen.get(c)||date)<=date),covered=active.filter(c=>delta.has(c));if(!hasUsableShareCoverage(active.length,covered.length))continue;
    const shares_change_yi=covered.reduce((n,c)=>n+delta.get(c)!,0),dayPrices=new Map(prices.get(date));if(date===latest)for(const [c,p]of live)dayPrices.set(c,p);
    const moneyComplete=covered.every(c=>dayPrices.has(c)),buy_amount_yi=moneyComplete?covered.reduce((n,c)=>n+Math.max(delta.get(c)!,0)*dayPrices.get(c)!,0):null;
    const sell_amount_yi=moneyComplete?covered.reduce((n,c)=>n+Math.abs(Math.min(delta.get(c)!,0))*dayPrices.get(c)!,0):null;
    const acts=activity.get(date),turnoverComplete=covered.every(c=>acts?.get(c)?.amount_yi!=null),volumeComplete=covered.every(c=>acts?.get(c)?.volume_lots!=null);
    const turnover_yi=turnoverComplete?covered.reduce((n,c)=>n+Number(acts!.get(c)!.amount_yi),0):null;
    const volume_yi=volumeComplete?covered.reduce((n,c)=>n+Number(acts!.get(c)!.volume_lots)*100/1e8,0):null;
    const baseline=amountHistory.length?amountHistory.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,amountHistory.length):0;
    out.push({date,pool_name:"汪汪队ETF合计",shares_change_yi,buy_amount_yi,sell_amount_yi,net_amount_yi:moneyComplete?buy_amount_yi!-sell_amount_yi!:null,turnover_yi,volume_yi,turnover_multiple:turnover_yi!=null&&baseline>0?turnover_yi/baseline:null,signal:shares_change_yi>0?"份额净增加":shares_change_yi<0?"份额净减少":"份额持平",coverage_count:covered.length,basket_count:active.length,fallback_count:covered.filter(c=>fallback.get(date)?.has(c)).length});
    if(turnoverComplete)amountHistory.push(turnover_yi!);
  }
  return days>0?out.slice(-days):out;
}

export async function loadFlowOverview(db: D1Database) {
  const [etfRows,historyRows,closeRows,snapshotRows]=await Promise.all([
    db.prepare("SELECT code,name,index_name,huijin_yi FROM etfs WHERE group_name='core' ORDER BY code").all<{code:string;name:string;index_name:string;huijin_yi:number|null}>(),
    db.prepare("SELECT trade_date,code,shares,source FROM share_history WHERE code IN (SELECT code FROM etfs WHERE group_name='core') AND source <> '腾讯行情份额字段' ORDER BY trade_date,code").all<{trade_date:string;code:string;shares:number;source:string}>(),
    db.prepare("SELECT trade_date,code,close_price FROM daily_closes WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date,code").all<{trade_date:string;code:string;close_price:number}>(),
    db.prepare("SELECT trade_date,code,payload_json FROM daily_snapshots WHERE trade_date=(SELECT MAX(trade_date) FROM daily_snapshots)").all<{trade_date:string;code:string;payload_json:string}>(),
  ]);
  const etfs=etfRows.results??[],codes=etfs.map(row=>row.code);
  if(!codes.length)return {as_of_date:null,metrics:[],indexes:[],etfs:[],core_count:0};
  const changes=new Map<string,Map<string,number>>(),sharesByDate=new Map<string,Map<string,number>>(),unconfirmed=new Set<string>(),previous=new Map<string,number>(),firstSeen=new Map<string,string>(),fallback=new Map<string,Set<string>>();
  for(const row of historyRows.results??[]){
    const shares=Number(row.shares);if(row.source==="腾讯行情份额字段")unconfirmed.add(row.trade_date);
    if(!firstSeen.has(row.code))firstSeen.set(row.code,row.trade_date);
    if(!sharesByDate.has(row.trade_date))sharesByDate.set(row.trade_date,new Map());sharesByDate.get(row.trade_date)!.set(row.code,shares);
    if(previous.has(row.code)){if(!changes.has(row.trade_date))changes.set(row.trade_date,new Map());changes.get(row.trade_date)!.set(row.code,(shares-previous.get(row.code)!)/1e8);}
    if(row.source.includes("兜底")){if(!fallback.has(row.trade_date))fallback.set(row.trade_date,new Set());fallback.get(row.trade_date)!.add(row.code);}
    previous.set(row.code,shares);
  }
  const prices=new Map<string,Map<string,number>>();for(const row of closeRows.results??[]){if(!prices.has(row.trade_date))prices.set(row.trade_date,new Map());prices.get(row.trade_date)!.set(row.code,Number(row.close_price));}
  const latest=snapshotRows.results?.[0]?.trade_date,live=new Map<string,number>();
  for(const row of snapshotRows.results??[]){try{const price=Number((JSON.parse(row.payload_json) as {price?:unknown}).price);if(price>0)live.set(row.code,price);}catch{}}
  const daily:{date:string;amount_yi:number;by_code:Map<string,number>;core_count:number;basket_count:number;fallback_count:number}[]=[];
  for(const date of [...changes.keys()].sort()){
    const delta=changes.get(date)!,active=codes.filter(code=>(firstSeen.get(code)||date)<=date),covered=active.filter(code=>delta.has(code));if(unconfirmed.has(date)||!hasUsableShareCoverage(active.length,covered.length))continue;
    const dayPrices=new Map(prices.get(date));if(date===latest)for(const [code,price]of live)dayPrices.set(code,price);
    if(!covered.every(code=>dayPrices.has(code)))continue;
    const by_code=new Map(covered.map(code=>[code,delta.get(code)!*dayPrices.get(code)!]));
    daily.push({date,amount_yi:[...by_code.values()].reduce((sum,value)=>sum+value,0),by_code,core_count:covered.length,basket_count:active.length,fallback_count:covered.filter(code=>fallback.get(date)?.has(code)).length});
  }
  if(!daily.length)return {as_of_date:null,metrics:[],indexes:[],etfs:[],core_count:codes.length};
  const as_of_date=daily.at(-1)!.date,year=as_of_date.slice(0,4);
  const shiftDays=(value:string,days:number)=>{const d=new Date(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10).replaceAll("-","");};
  const shiftMonths=(value:string,months:number)=>{const y=Number(value.slice(0,4)),m=Number(value.slice(4,6))-1,day=Number(value.slice(6,8));const first=new Date(Date.UTC(y,m+months,1));const lastDay=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();return `${first.getUTCFullYear()}${String(first.getUTCMonth()+1).padStart(2,"0")}${String(Math.min(day,lastDay)).padStart(2,"0")}`;};
  const rangeStarts={latest:as_of_date,week:shiftDays(as_of_date,-6),month:shiftMonths(as_of_date,-1),half_year:shiftMonths(as_of_date,-6),year:shiftMonths(as_of_date,-12),ytd:`${year}0101`};
  const specs=[{key:"latest",label:"最新交易日合计"},{key:"week",label:"近一周累计"},{key:"month",label:"近一月累计"},{key:"half_year",label:"近半年累计"},{key:"year",label:"近一年累计"},{key:"ytd",label:"今年以来累计"}];
  const datesByWindow=new Map<string,string[]>();
  const metrics=specs.map(spec=>{const selected=daily.filter(row=>row.date>=rangeStarts[spec.key as keyof typeof rangeStarts]&&row.date<=as_of_date);datesByWindow.set(spec.key,selected.map(row=>row.date));return {key:spec.key,label:spec.label,value_yi:selected.reduce((sum,row)=>sum+row.amount_yi,0),trading_days:selected.length,start_date:selected[0]?.date??null,as_of_date:selected.at(-1)?.date??null};});
  const byCode=new Map<string,Map<string,number>>();for(const code of codes)byCode.set(code,new Map());
  for(const day of daily)for(const [code,value]of day.by_code)byCode.get(code)!.set(day.date,value);
  const sumCode=(code:string,window:string)=>{const selected=new Set(datesByWindow.get(window)??[]);return [...(byCode.get(code)??new Map())].reduce((sum,[date,value])=>sum+(selected.has(date)?value:0),0);};
  const latestShares=sharesByDate.get(as_of_date)??new Map();
  const rows=etfs.map(etf=>({code:etf.code,name:etf.name,index_name:etf.index_name,huijin_yi:etf.huijin_yi,shares_yi:(latestShares.get(etf.code)??0)/1e8,
    latest_yi:sumCode(etf.code,"latest"),week_yi:sumCode(etf.code,"week"),month_yi:sumCode(etf.code,"month"),ytd_yi:sumCode(etf.code,"ytd")}));
  const recent_dates=daily.slice(-10).map(row=>row.date);
  const daily_matrix=etfs.map(etf=>({code:etf.code,name:etf.name,index_name:etf.index_name,values:recent_dates.map(date=>daily.find(day=>day.date===date)?.by_code.get(etf.code)??null)}));
  const grouped=new Map<string,{index_name:string;etf_count:number;shares_yi:number;reported_huijin_yi:number;reported_huijin_count:number;latest_yi:number;week_yi:number;month_yi:number;ytd_yi:number}>();
  for(const row of rows){const group=grouped.get(row.index_name)??{index_name:row.index_name,etf_count:0,shares_yi:0,reported_huijin_yi:0,reported_huijin_count:0,latest_yi:0,week_yi:0,month_yi:0,ytd_yi:0};group.etf_count++;for(const key of ["shares_yi","latest_yi","week_yi","month_yi","ytd_yi"] as const)group[key]+=row[key];if(row.huijin_yi!=null){group.reported_huijin_yi+=Number(row.huijin_yi);group.reported_huijin_count++;}grouped.set(row.index_name,group);}
  rows.sort((a,b)=>b.month_yi-a.month_yi);
  const indexes=[...grouped.values()].sort((a,b)=>b.month_yi-a.month_yi);
  const latestCoverage=daily.at(-1)!;
  return {as_of_date,year,core_count:codes.length,coverage_count:latestCoverage.core_count,basket_count:latestCoverage.basket_count,fallback_count:latestCoverage.fallback_count,metrics,indexes,etfs:rows,recent_dates,daily_matrix,
    method:"区间按日历跨度回溯，交易日数按实际交易记录动态统计，节假日不计。新上市 ETF 从首次披露份额后纳入当日合计；逐只 ETF 份额变化 × 同日收盘价，最新日缺收盘价时使用行情快照。历史每日覆盖数量随篮子中新上市 ETF 逐步纳入而变化。",
    holding_note:"2025年报披露份额仅代表历史披露时点；ETF总份额是全市场发行量，不代表国家队当前持有。申赎估算不能识别实际交易账户。"};
}
