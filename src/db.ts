export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
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
    WHERE e.group_name='core' ORDER BY h.trade_date,h.code
  `).all<{trade_date:string;code:string;shares:number;source:string;group_name:string}>();
  const codes = core.map(item => String(item.code));
  const byDate = new Map<string,Map<string,number>>(), unconfirmed = new Set<string>();
  for (const row of history.results ?? []) {
    if (row.source === "腾讯行情份额字段") unconfirmed.add(row.trade_date);
    if (!byDate.has(row.trade_date)) byDate.set(row.trade_date,new Map());
    byDate.get(row.trade_date)!.set(row.code,Number(row.shares));
  }
  let previous: number | null = null;
  const pool = [...byDate.keys()].sort().flatMap(date => {
    if (unconfirmed.has(date)) return [];
    const shares=byDate.get(date)!;
    if (!codes.length || !codes.every(code => shares.has(code))) return [];
    const total=codes.reduce((n,code)=>n+shares.get(code)!,0),delta=previous===null?null:(total-previous)/1e8;
    previous=total;
    return [{date,shares_yi:total/1e8,delta_yi:delta,core_count:codes.length}];
  });
  const latest_run = await db.prepare("SELECT id,started_at,finished_at,status,trade_date,message,source FROM collection_runs ORDER BY id DESC LIMIT 1").first();
  const metaRows = await db.prepare("SELECT key,value FROM app_meta").all<{key:string;value:string}>();
  const meta = Object.fromEntries((metaRows.results ?? []).map(row => [row.key,row.value]));
  return {
    runtime: "cloudflare", generated_at: new Date().toISOString(), trade_date: latest,
    source: meta.source || "腾讯行情公开接口；新浪 5 分钟 K 线",
    huijin_basis: meta.huijin_basis || "2025 年报历史披露口径，仅为历史标签",
    prev_share_date: meta.prev_share_date || null, latest_run,
    summary: { amount_yi,avg20_yi,ratio,flow_yi,active_net_yi,weighted_pct,progress,verdict,core_count:core.length,total_count:etfs.length },
    etfs,history:{pool},
  };
}

export async function loadFlowDetail(db: D1Database, date: string) {
  const {results=[]} = await db.prepare(`
    SELECT e.code,e.name,h.shares,prev.shares AS prev_shares,a.amount_yi,a.volume_lots,h.source,c.close_price
    FROM etfs e JOIN share_history h ON h.code=e.code AND h.trade_date=?
    LEFT JOIN share_history prev ON prev.code=e.code AND prev.trade_date=(
      SELECT MAX(p.trade_date) FROM share_history p WHERE p.code=e.code AND p.trade_date<h.trade_date)
    LEFT JOIN daily_activity a ON a.code=e.code AND a.trade_date=h.trade_date
    LEFT JOIN daily_closes c ON c.code=e.code AND c.trade_date=h.trade_date
    WHERE e.group_name='core' ORDER BY e.code
  `).bind(date).all<Record<string,unknown>>();
  if (results.some(row=>row.source==="腾讯行情份额字段")) return {date,core_count:results.length,items:[],buy_yi:0,sell_yi:0,net_yi:0,volume_yi:null,amount_yi:null,volume_coverage:0,amount_coverage:0};
  let buy=0,sell=0,volume=0,amount=0,volume_coverage=0,amount_coverage=0;
  let buy_amount=0,sell_amount=0,buy_count=0,sell_count=0,buy_amount_coverage=0,sell_amount_coverage=0;
  const items=results.map(row=>{
    const delta=row.prev_shares==null?null:(Number(row.shares)-Number(row.prev_shares))/1e8;
    const volume_yi=row.volume_lots==null?null:Number(row.volume_lots)*100/1e8;
    const amount_yi=row.amount_yi==null?null:Number(row.amount_yi);
    const estimated_amount_yi=delta!==null&&row.close_price!=null?delta*Number(row.close_price):null;
    if(delta!==null){if(delta>0){buy+=delta;buy_count++;if(estimated_amount_yi!==null){buy_amount+=estimated_amount_yi;buy_amount_coverage++;}}else if(delta<0){sell+=Math.abs(delta);sell_count++;if(estimated_amount_yi!==null){sell_amount+=Math.abs(estimated_amount_yi);sell_amount_coverage++;}}}
    if(volume_yi!==null){volume+=volume_yi;volume_coverage++;}
    if(amount_yi!==null){amount+=amount_yi;amount_coverage++;}
    return {code:row.code,name:row.name,delta_yi:delta,buy_amount_yi:estimated_amount_yi===null?null:Math.max(estimated_amount_yi,0),
      sell_amount_yi:estimated_amount_yi===null?null:Math.abs(Math.min(estimated_amount_yi,0)),volume_yi,amount_yi,source:row.source};
  });
  return {date,core_count:items.length,items,buy_yi:buy,sell_yi:sell,buy_amount_yi:buy_amount,sell_amount_yi:sell_amount,
    buy_count,sell_count,buy_amount_coverage,sell_amount_coverage,net_yi:buy-sell,
    volume_yi:volume_coverage?volume:null,amount_yi:amount_coverage?amount:null,volume_coverage,amount_coverage};
}

export async function loadPoolStatistics(db: D1Database, days: number) {
  const [coreRows,histRows,activityRows,closeRows,snapshotRows] = await Promise.all([
    db.prepare("SELECT code FROM etfs WHERE group_name='core' ORDER BY code").all<{code:string}>(),
    db.prepare("SELECT trade_date,code,shares,source FROM share_history WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date,code").all<{trade_date:string;code:string;shares:number;source:string}>(),
    db.prepare("SELECT trade_date,code,amount_yi,volume_lots FROM daily_activity WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date").all<{trade_date:string;code:string;amount_yi:number|null;volume_lots:number|null}>(),
    db.prepare("SELECT trade_date,code,close_price FROM daily_closes WHERE code IN (SELECT code FROM etfs WHERE group_name='core') ORDER BY trade_date").all<{trade_date:string;code:string;close_price:number}>(),
    db.prepare("SELECT trade_date,code,payload_json FROM daily_snapshots WHERE trade_date=(SELECT MAX(trade_date) FROM daily_snapshots)").all<{trade_date:string;code:string;payload_json:string}>(),
  ]);
  const codes=(coreRows.results??[]).map(row=>row.code), changes=new Map<string,Map<string,number>>(), unconfirmed=new Set<string>(), prev=new Map<string,number>();
  for(const row of histRows.results??[]){if(row.source==="腾讯行情份额字段")unconfirmed.add(row.trade_date);if(prev.has(row.code)){if(!changes.has(row.trade_date))changes.set(row.trade_date,new Map());changes.get(row.trade_date)!.set(row.code,(Number(row.shares)-prev.get(row.code)!)/1e8);}prev.set(row.code,Number(row.shares));}
  const activity=new Map<string,Map<string,typeof activityRows.results[number]>>();for(const row of activityRows.results??[]){if(!activity.has(row.trade_date))activity.set(row.trade_date,new Map());activity.get(row.trade_date)!.set(row.code,row);}
  const prices=new Map<string,Map<string,number>>();for(const row of closeRows.results??[]){if(!prices.has(row.trade_date))prices.set(row.trade_date,new Map());prices.get(row.trade_date)!.set(row.code,Number(row.close_price));}
  const latest=(snapshotRows.results??[])[0]?.trade_date;const live=new Map<string,number>();for(const row of snapshotRows.results??[]){const p=JSON.parse(row.payload_json);if(p.price)live.set(row.code,Number(p.price));}
  const amountHistory:number[]=[],out=[];
  for(const date of [...changes.keys()].sort()){
    if(unconfirmed.has(date))continue;const delta=changes.get(date)!;if(!codes.length||!codes.every(c=>delta.has(c)))continue;
    const shares_change_yi=codes.reduce((n,c)=>n+delta.get(c)!,0),dayPrices=new Map(prices.get(date));if(date===latest)for(const [c,p]of live)dayPrices.set(c,p);
    const moneyComplete=codes.every(c=>dayPrices.has(c)),buy_amount_yi=moneyComplete?codes.reduce((n,c)=>n+Math.max(delta.get(c)!,0)*dayPrices.get(c)!,0):null;
    const sell_amount_yi=moneyComplete?codes.reduce((n,c)=>n+Math.abs(Math.min(delta.get(c)!,0))*dayPrices.get(c)!,0):null;
    const acts=activity.get(date),turnoverComplete=codes.every(c=>acts?.get(c)?.amount_yi!=null),volumeComplete=codes.every(c=>acts?.get(c)?.volume_lots!=null);
    const turnover_yi=turnoverComplete?codes.reduce((n,c)=>n+Number(acts!.get(c)!.amount_yi),0):null;
    const volume_yi=volumeComplete?codes.reduce((n,c)=>n+Number(acts!.get(c)!.volume_lots)*100/1e8,0):null;
    const baseline=amountHistory.length?amountHistory.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,amountHistory.length):0;
    out.push({date,pool_name:"汪汪队ETF合计",shares_change_yi,buy_amount_yi,sell_amount_yi,net_amount_yi:moneyComplete?buy_amount_yi!-sell_amount_yi!:null,turnover_yi,volume_yi,turnover_multiple:turnover_yi!=null&&baseline>0?turnover_yi/baseline:null,signal:shares_change_yi>0?"份额净增加":shares_change_yi<0?"份额净减少":"份额持平"});
    if(turnoverComplete)amountHistory.push(turnover_yi!);
  }
  return days>0?out.slice(-days):out;
}
