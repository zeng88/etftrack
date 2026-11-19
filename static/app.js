(() => {
  const $ = (id) => document.getElementById(id);
  let dashboard = null;
  let flowOverview = null;
  let poolRanges = {flow: 60, index: 240};
  let statsDays = 20;
  let poolStats = [];
  let liveFlow = null;
  let liveTurnover = null;
  let turnoverSelection = "aggregate";
  let selectedFlowDate = null;
  let currentFlowDetail = null;
  let toastTimer = null;
  let dashboardRefreshBusy = false;
  let liveTurnoverRefreshBusy = false;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const number = (v,d=1) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("zh-CN",{minimumFractionDigits:d,maximumFractionDigits:d}) : "—";
  const signed = (v,d=1) => `${Number(v)>0?"+":Number(v)<0?"−":""}${number(Math.abs(Number(v)||0),d)}`;
  const flowLabel = v => Math.abs(Number(v)||0)<0.01?`${signed((Number(v)||0)*1e8,0)} 份`:`${signed(v,2)} 亿份`;
  const tone = v => Number(v)>0?"pos":Number(v)<0?"neg":"neutral";
  const dateLabel = v => {const s=String(v||"").replaceAll("-","");return /^\d{8}$/.test(s)?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:(v||"—");};
  const shortDate = v => {const s=String(v||"").replaceAll("-","");return /^\d{8}$/.test(s)?`${Number(s.slice(4,6))}月${Number(s.slice(6,8))}日`:(v||"—");};
  const timeLabel = v => {if(!v)return "—";const s=String(v);if(/^\d{14}$/.test(s))return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`;if(s.endsWith("Z"))return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(s));return s.replace("T"," ").slice(0,16);};
  const localClock = () => new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:"Asia/Shanghai"}).format(new Date());
  const shanghaiNow = () => new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(new Date());
  const marketPhase = now => {const weekday=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Shanghai",weekday:"short"}).format(new Date()).toLowerCase();if(weekday==="sat"||weekday==="sun")return "offday";const hm=now.slice(11,16);if((hm>="09:30"&&hm<="11:30")||(hm>="13:00"&&hm<="15:00"))return "open";if(hm>"11:30"&&hm<"13:00")return "lunch";return hm>="15:00"?"closed":"preopen";};
  function toast(message,isError=false){const el=$("toast");el.textContent=message;el.className=`toast show${isError?" error":""}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className="toast",3800);}
  async function loadDashboard(){const [r,s,o]=await Promise.all([fetch("/api/dashboard",{cache:"no-store"}),fetch(`/api/pool-stats?days=${statsDays}`,{cache:"no-store"}),fetch("/api/flow-overview",{cache:"no-store"})]);if(!r.ok)throw new Error(`数据读取失败（${r.status}）`);if(!s.ok||!o.ok)throw new Error("统计接口暂不可用");dashboard=await r.json();if(!dashboard.etfs?.length)throw new Error(dashboard.error||"暂无 ETF 行情数据");if(s.ok){const data=await s.json();poolStats=data.rows||[];}else poolStats=[];if(o.ok)flowOverview=await o.json();else flowOverview=null;if(liveFlow)applyLiveQuotes(liveFlow,false);render();}
  function render(){renderStatus();renderSummary();renderFlowOverview();renderPoolCharts();renderPoolStats();renderTable();if(liveFlow)renderLiveFlow();}
  function turnoverAt(points,time){const rows=(points||[]).filter(point=>String(point.time)<=time);return rows.length?Number(rows.at(-1).amount_yi)||0:0;}
  function renderLiveTurnoverChart(){
    const chart=$("live-turnover-chart"),data=liveTurnover;if(!data){chart.innerHTML='<div class="chart-empty">实时成交走势暂不可用，等待下一轮公开行情刷新</div>';return;}
    const selected=turnoverSelection==="aggregate"?{name:`热门宽基合计（${data.comparison_count}只）`,today:data.aggregate?.today||[],previous:data.aggregate?.previous||[]}:data.items?.find(item=>item.code===turnoverSelection);
    if(!selected?.today?.length||!selected?.previous?.length){chart.innerHTML='<div class="chart-empty">当前观察对象没有完整的两日五分钟成交数据</div>';return;}
    const latest=selected.today.at(-1),current=Number(latest.amount_yi)||0,previous=turnoverAt(selected.previous,latest.time),delta=current-previous;
    $("turnover-current").textContent=`${number(current,2)} 亿`;$("turnover-previous").textContent=`${number(previous,2)} 亿`;$("turnover-delta").textContent=`较上一交易日同刻 ${signed(delta,2)} 亿`;$("turnover-delta").className=`turnover-delta ${tone(delta)}`;
    const names=data.items?.map(item=>`${item.name}（${item.code}）`).join("、")||"—";
    $("turnover-scope").textContent=turnoverSelection==="aggregate"?`比较对象：${names}`:`当前观察：${selected.name}（${selected.code}）`;
    $("turnover-source").textContent=`数据时间 ${dateLabel(data.date)} ${latest.time} · ${data.source||"公开行情"}`;$("turnover-note").textContent=data.note||"曲线为日内累计成交额，不代表资金净流入，也不能确认具体交易账户。";
    const values=[...selected.today,...selected.previous].map(point=>Number(point.amount_yi)||0),rawMax=Math.max(...values,1),w=860,h=270,left=54,right=18,top=18,bottom=35,iw=w-left-right,ih=h-top-bottom;
    const marketOffset=time=>{const match=String(time).match(/^(\d{2}):(\d{2})/);if(!match)return 0;const minute=Number(match[1])*60+Number(match[2]);return Math.max(0,Math.min(240,minute<780?minute-570:minute-660));};
    const niceStep=value=>{const rough=value/4,magnitude=10**Math.floor(Math.log10(Math.max(rough,.01))),fraction=rough/magnitude,nice=fraction<=1?1:fraction<=2?2:fraction<=2.5?2.5:fraction<=5?5:10;return nice*magnitude;};
    const step=niceStep(rawMax),max=Math.ceil(rawMax/step)*step,x=time=>left+marketOffset(time)/240*iw,y=value=>top+(max-value)/max*ih,makePath=points=>points.map((point,index)=>`${index?"L":"M"}${x(String(point.time)).toFixed(1)},${y(Number(point.amount_yi)||0).toFixed(1)}`).join(" ");
    const yValues=Array.from({length:Math.round(max/step)+1},(_,index)=>index*step),yTicks=yValues.map(value=>`<line class="grid-line" x1="${left}" y1="${y(value)}" x2="${w-right}" y2="${y(value)}"/><text class="axis-label" text-anchor="end" x="${left-8}" y="${y(value)+3}">${number(value,0)}</text>`).join(""),allLabels=["09:30","10:00","10:30","11:00","13:00","13:30","14:00","14:30","15:00"],timeLabels=(window.innerWidth<620?allLabels.filter((_,index)=>index%2===0||index===allLabels.length-1):allLabels),labels=timeLabels.map((time,index)=>`<text class="axis-label turnover-axis-label" text-anchor="${index===0?"start":index===timeLabels.length-1?"end":"middle"}" x="${x(time)}" y="${h-7}">${time}</text>`).join("");
    chart.innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(selected.name)} 今日与上一交易日累计成交额曲线"><path class="turnover-area" d="${makePath(selected.today)} L${x(String(latest.time)).toFixed(1)},${y(0).toFixed(1)} L${x(String(selected.today[0].time)).toFixed(1)},${y(0).toFixed(1)} Z"/>${yTicks}<path class="turnover-line previous" d="${makePath(selected.previous)}"/><path class="turnover-line today" d="${makePath(selected.today)}"/><circle class="turnover-point today" cx="${x(String(latest.time))}" cy="${y(current)}" r="4"/>${labels}</svg>`;
    const detail=$("turnover-point-detail"),showPoint=time=>{const now=turnoverAt(selected.today,time),before=turnoverAt(selected.previous,time),gap=now-before;detail.innerHTML=`<b>${dateLabel(data.date)} ${esc(time)}</b><span>今日 ${number(now,2)} 亿</span><span>${dateLabel(data.previous_date)} 同刻 ${number(before,2)} 亿</span><strong class="${tone(gap)}">${signed(gap,2)} 亿</strong>`;};
    showPoint(String(latest.time));
    chart.querySelector("svg").addEventListener("click",event=>{const rect=event.currentTarget.getBoundingClientRect(),viewX=(event.clientX-rect.left)/rect.width*w,target=(viewX-left)/iw*240,candidates=[...selected.today,...selected.previous],nearest=candidates.reduce((best,point)=>Math.abs(marketOffset(point.time)-target)<Math.abs(marketOffset(best.time)-target)?point:best,candidates[0]);showPoint(String(nearest.time));});
  }
  async function refreshLiveTurnover(){
    if(liveTurnoverRefreshBusy)return;liveTurnoverRefreshBusy=true;
    try{const r=await fetch("/api/live-turnover",{cache:"no-store"}),data=await r.json();if(!r.ok)throw new Error(data.error||"实时成交走势暂不可用");liveTurnover=data;
      const select=$("turnover-etf-select"),options=[...select.options].map(option=>option.value);for(const item of data.items||[])if(!options.includes(item.code)){const option=document.createElement("option");option.value=item.code;option.textContent=`${item.name}（${item.code}）`;select.append(option);}if(turnoverSelection!=="aggregate"&&!(data.items||[]).some(item=>item.code===turnoverSelection)){turnoverSelection="aggregate";select.value="aggregate";}renderLiveTurnoverChart();
    }catch(error){if(!liveTurnover)$("live-turnover-chart").innerHTML=`<div class="chart-empty">${esc(error.message||"实时成交走势暂不可用")}</div>`;}finally{liveTurnoverRefreshBusy=false;}
  }
  function renderFlowOverview(){
    const data=flowOverview,cards=$("flow-metric-cards");
    if(!data?.metrics?.length){$("flow-overview-date").textContent="暂无完整金额数据";$("flow-overview-meta").textContent="等待份额与价格数据完整";cards.innerHTML='<div class="flow-metric-card flow-metric-loading">当前没有满足完整口径的交易日数据</div>';$("flow-index-rows").innerHTML='<tr><td colspan="8" class="empty-row">暂无完整数据</td></tr>';$("flow-etf-rows").innerHTML='<tr><td colspan="8" class="empty-row">暂无完整数据</td></tr>';return;}
    const overviewCoverage=Number(data.coverage_count)||0,overviewBasket=Number(data.basket_count)||Number(data.core_count)||0;
    $("flow-overview-date").textContent=`最新交易日 ${dateLabel(data.as_of_date)}`;$("flow-overview-meta").textContent=`核心观察池 ${data.core_count} 只${overviewBasket>overviewCoverage?` · 最新日 ${overviewCoverage}/${overviewBasket} 只已披露`:""}${Number(data.fallback_count)>0?` · 含${data.fallback_count}只兜底`:""} · 金额单位：亿元`;
    cards.innerHTML=data.metrics.map(metric=>{const value=Number(metric.value_yi)||0,action=value>0?"净买入":value<0?"净卖出":"买卖接近",cls=tone(value);const suffix=metric.key==="latest"?dateLabel(metric.as_of_date):`${number(metric.trading_days,0)}个交易日`;return `<article class="flow-metric-card ${cls}"><span>${esc(metric.label)}（${esc(suffix)}）</span><strong>${signed(value,2)}</strong><small>${action} 亿元</small></article>`;}).join("");
    const valueCell=value=>`<td class="right money ${tone(value)}">${signed(value,2)}</td>`;
    $("flow-index-rows").innerHTML=(data.indexes||[]).map(row=>`<tr><td><b>${esc(row.index_name)}</b></td><td class="right">${number(row.etf_count,0)}</td><td class="right money">${number(row.shares_yi,1)}</td><td class="right money">${row.reported_huijin_count?number(row.reported_huijin_yi,1):"—"}${row.reported_huijin_count&&row.reported_huijin_count<row.etf_count?`<small class="subnote">${row.reported_huijin_count}/${row.etf_count}只已披露</small>`:""}</td>${valueCell(row.latest_yi)}${valueCell(row.week_yi)}${valueCell(row.month_yi)}${valueCell(row.ytd_yi)}</tr>`).join("")||'<tr><td colspan="8" class="empty-row">暂无品种汇总</td></tr>';
    $("flow-etf-rows").innerHTML=(data.etfs||[]).map(row=>`<tr><td><div class="flow-etf-label"><b>${esc(row.name)}</b><small>${esc(row.code)}</small></div></td><td>${esc(row.index_name)}</td><td class="right money">${number(row.shares_yi,1)}</td><td class="right money">${row.huijin_yi==null?"—":number(row.huijin_yi,1)}</td>${valueCell(row.latest_yi)}${valueCell(row.week_yi)}${valueCell(row.month_yi)}${valueCell(row.ytd_yi)}</tr>`).join("")||'<tr><td colspan="8" class="empty-row">暂无 ETF 明细</td></tr>';
    const dates=data.recent_dates||[],rank=new Map((data.etfs||[]).map((row,index)=>[row.code,index])),matrix=[...(data.daily_matrix||[])].sort((a,b)=>(rank.get(a.code)??999)-(rank.get(b.code)??999));
    $("flow-daily-head").innerHTML=`<tr><th>ETF</th><th>跟踪指数</th>${dates.map(date=>`<th class="right">${esc(shortDate(date))}</th>`).join("")}</tr>`;
    $("flow-daily-rows").innerHTML=matrix.map(row=>`<tr><td><b>${esc(row.name)}</b><small class="flow-matrix-code">${esc(row.code)}</small></td><td>${esc(row.index_name)}</td>${(row.values||[]).map(value=>`<td class="right money ${value==null?"neutral":tone(value)}">${value==null?"—":signed(value,2)}</td>`).join("")}</tr>`).join("")||'<tr><td colspan="12" class="empty-row">暂无逐日明细</td></tr>';
    $("flow-overview-method").textContent=`估算口径：${data.method||"份额变化 × 当日价格"} ${data.holding_note||""}`;
  }
  function renderStatus(){
    const run=dashboard.latest_run,newest=dashboard.etfs[0];
    const cloud=dashboard.runtime==="cloudflare";
    $("asof-date").textContent=dateLabel(dashboard.trade_date||newest?.date);
    $("asof-time").textContent=`行情时间 ${timeLabel(newest?.source_ts||newest?.ts)}`;
    $("source-line").textContent="行情来自公开数据，份额以交易所披露为准";
    $("footer-source").textContent="公开行情 · 交易所份额披露";
    const conn=$("connection"),state=$("market-state"),fresh=$("freshness");
    const workerRun=run?.source==="Cloudflare Worker Cron";
    const failedRun=run?.status==="failed"&&(!cloud||workerRun);
    const runWeekday=run?.started_at?new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Shanghai",weekday:"short"}).format(new Date(run.started_at)).toLowerCase():"";
    const offdayFailure=Boolean(failedRun&&cloud&&(runWeekday==="sat"||runWeekday==="sun"));
    const failed=Boolean(failedRun&&!offdayFailure);
    conn.classList.toggle("offline",Boolean(failed));
    conn.querySelector("span").textContent=failed?"定时行情采集失败":offdayFailure?"非交易日补采超时":"行情服务正常";
    state.textContent=failed||offdayFailure?"保留最近有效数据":"资金观察台";
    fresh.textContent=failed?"定时采集未完成，仍显示最近完整数据":offdayFailure?"非交易日任务超时，不影响最近交易日行情":cloud?"盘中行情每 20 秒刷新":run?.finished_at?`最近采集 ${timeLabel(run.finished_at)}`:"等待首次采集";
    if(cloud&&!workerRun){$("collection-last-run").textContent="等待首次收盘采集";}
    else if(run){
      const label=run.status==="failed"?(offdayFailure?"非交易日补采超时，保留有效数据":"定时采集失败"):run.message?.includes("官方份额未齐")?"行情已更新，官方份额待补":"采集成功";
      $("collection-last-run").textContent=`${label} · ${timeLabel(run.finished_at)}`;
    }else $("collection-last-run").textContent="尚无采集记录";
    const confirmedRow=(dashboard.history?.pool||[]).filter(row=>row.delta_yi!=null).at(-1);
    const confirmedCoverage=Number(confirmedRow?.core_count)||0,confirmedBasket=Number(confirmedRow?.basket_count)||confirmedCoverage;
    const latestCoverage=dashboard.latest_share_coverage||{};
    let shareText=confirmedRow
      ?`最新确认份额：${dateLabel(confirmedRow.date)}${confirmedBasket>confirmedCoverage?` · ${confirmedCoverage}/${confirmedBasket} 只已披露`:""}${Number(confirmedRow.fallback_count)>0?` · 含 ${confirmedRow.fallback_count} 只兜底`:""}`
      :"尚无确认份额记录";
    if(latestCoverage.date&&(!confirmedRow||latestCoverage.date>confirmedRow.date)){
      shareText+=` · ${dateLabel(latestCoverage.date)} 行情已采集，官方份额 ${Number(latestCoverage.covered)||0}/${Number(latestCoverage.basket)||dashboard.summary?.core_count||0} 待披露`;
    }
    $("share-data-date").textContent=shareText;
  }
  function renderSummary(){
    const s=dashboard.summary||{},ratio=Number(s.ratio)||0;
    const ready=Number(s.amount_yi)>0&&Number(s.avg20_yi)>0;
    $("signal-title").textContent=!ready?"等待当日成交数据":ratio>=1.8?"观察到资金活跃迹象":ratio>=1.3?"成交有所活跃，方向待观察":"暂未看到明显介入迹象";
    $("signal-copy").textContent=ready?`核心池成交额约为历史同时点基线的 ${number(ratio,2)} 倍。份额与成交方向都是代理信号，不能确认具体交易账户。`:"当日成交数据尚未齐备，暂不生成资金活跃判断。";
    $("signal-scope-count").textContent=number(s.core_count||34,0);
    $("scope-label").textContent=`${s.core_count||34} 只宽基 · ${Math.max(0,(s.total_count||35)-(s.core_count||34))} 只扩展`;
    $("today-signal-meter").style.width=`${Math.min(100,Math.max(0,ratio/2.5*100))}%`;
    $("metric-ratio").textContent=`${number(s.ratio,2)}×`;$("metric-ratio-note").textContent=`${number((s.progress||0)*100,0)}% 历史成交进度已完成`;$("ratio-meter").style.width=`${Math.min(100,Math.max(0,(Number(s.ratio)||0)/2.5*100))}%`;
    $("metric-amount").textContent=`${number(s.amount_yi,1)} 亿`;$("metric-avg").textContent=`20 日均额 ${number(s.avg20_yi,1)} 亿`;
    $("metric-change").textContent=`${signed(s.weighted_pct,2)}%`;$("metric-change").className=`metric-value ${tone(s.weighted_pct)}`;$("metric-active").textContent=`${signed(s.active_net_yi,1)} 亿`;$("metric-active").className=`metric-value ${tone(s.active_net_yi)}`;
    $("table-count").textContent=`${s.total_count||0} 只 ETF · 重点 ${s.core_count||0} 只`;
  }
  function renderLiveFlow(){
    if(!liveFlow)return;
    const stamp=String(liveFlow.time||""),now=shanghaiNow(),today=now.slice(0,10).replaceAll("-","");
    const sourceDate=stamp.slice(0,8),sourceEpoch=/^\d{14}$/.test(stamp)?new Date(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00`).getTime():0;
    const quoteAge=sourceEpoch?Math.max(0,Date.now()-sourceEpoch):Infinity,sameDay=sourceDate===today,phase=marketPhase(now),session=phase==="open",fresh=sameDay&&quoteAge<=120000;
    const buy=Number(liveFlow.buy_yi)||0,sell=Number(liveFlow.sell_yi)||0,net=Number(liveFlow.net_yi)||buy-sell,amount=Number(liveFlow.amount_yi)||0;
    const netShare=amount>0?Math.abs(net)/amount:0;
    const dominance=netShare<0.03?"买卖接近，暂看不出明显护盘":net>0?"买入占优，可能有护盘迹象":"卖出占优，暂未见明显护盘";
    const netText=net>0?`净买入 ${number(net,2)} 亿`:net<0?`净卖出 ${number(Math.abs(net),2)} 亿`:"买卖大致持平";
    const phaseLabel={lunch:"午间快照",closed:"收盘快照",preopen:"盘前快照",offday:"非交易日快照"}[phase];
    const timing=!sameDay?`最近行情 ${dateLabel(sourceDate)} ${timeLabel(stamp).slice(-5)}`:session?(fresh?`实时行情源 ${timeLabel(stamp).slice(-5)}`:`行情延迟 · 源时间 ${timeLabel(stamp).slice(-5)}`):`${phaseLabel} · 源时间 ${timeLabel(stamp).slice(-5)}`;
    const delayed=session&&!fresh;
    $("signal-label").textContent=`${sameDay?"今日判断":"最近交易日判断"} · 国家队是否上班（估算）`;
    $("live-buy").textContent=`${number(buy,2)} 亿`;
    $("live-sell").textContent=`${number(sell,2)} 亿`;
    $("live-net").textContent=`${signed(net,2)} 亿`;
    $("live-net").className=net>0?"buy-tone":net<0?"sell-tone":"";
    $("live-source").textContent=timing;
    $("signal-title").textContent=delayed?"盘中行情延迟，保留上次估算":session?(fresh?dominance:"盘中行情暂未刷新"):sameDay?`${phaseLabel} · ${dominance}`:`最近交易日 · ${dominance}`;
    const period=sameDay?"当日":"最近交易日";
    $("signal-copy").textContent=`${period}核心宽基 ETF 成交 ${number(amount,2)} 亿，${netText}。按成交方向推测是否有护盘买盘，无法确认国家队账户；下方历史金额按份额变化 × 价格计算，口径不同。`;
    $("today-signal-meter").style.width=`${Math.min(100,Math.max(0,netShare*500))}%`;
    $("metric-active").textContent=`${signed(net,1)} 亿`;
    $("metric-active").className=`metric-value ${tone(liveFlow.net_yi)}`;
    $("metric-active-note").textContent=`买 ${number(buy,1)} 亿 · 卖 ${number(sell,1)} 亿 · ${liveFlow.core_count} 只重点 ETF`;
    $("live-update-label").textContent="估算请求每 20 秒自动刷新";
    $("live-update-time").textContent=`行情源 ${timeLabel(stamp)}`;
    $("refresh-status").classList.remove("offline");
    $("refresh-status").querySelector("span").textContent=`估算已更新 ${localClock()}`;
  }
  let liveRefreshBusy=false;
  function applyLiveQuotes(data,redraw=true){
    if(!dashboard?.etfs?.length||!Array.isArray(data?.items))return;
    const quotes=new Map(data.items.map(item=>[String(item.code),item]));
    dashboard.etfs=dashboard.etfs.map(item=>{
      const quote=quotes.get(String(item.code));if(!quote)return item;
      const hist=[...(item.hist||[])],quoteDate=String(quote.date||"").replaceAll("-","");
      if(quoteDate&&Number.isFinite(Number(quote.amount_yi))){
        const index=hist.findIndex(point=>String(point.date||"").replaceAll("-","")===quoteDate),point={date:quoteDate,amount_yi:Number(quote.amount_yi)};
        if(index>=0)hist[index]=point;else hist.push(point);hist.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
      }
      const baseline=hist.filter(point=>String(point.date||"").replaceAll("-","")<quoteDate&&point.amount_yi!=null&&Number.isFinite(Number(point.amount_yi))).slice(-20);
      const avg20_yi=baseline.length?baseline.reduce((sum,point)=>sum+Number(point.amount_yi),0)/baseline.length:item.avg20_yi;
      return {...item,...quote,avg20_yi,name:item.name,index:item.index,group:item.group,huijin_yi:item.huijin_yi,
        source_ts:quote.ts||data.time,source_name:"腾讯实时行情",hist};
    });
    if(data.date)dashboard.trade_date=data.date;
    const core=dashboard.etfs.filter(item=>item.group==="core");
    const amount=core.reduce((sum,item)=>sum+Math.max(Number(item.amount_yi)||0,0),0);
    const cap=core.reduce((sum,item)=>sum+Math.max(Number(item.mktcap_yi)||0,0),0);
    const weightedPct=cap?core.reduce((sum,item)=>sum+(Number(item.pct)||0)*(Number(item.mktcap_yi)||0),0)/cap:0;
    const activeNet=core.reduce((sum,item)=>{const outer=Math.max(Number(item.outer_lots)||0,0),inner=Math.max(Number(item.inner_lots)||0,0),total=outer+inner;return sum+(total?((outer-inner)/total)*(Number(item.amount_yi)||0):0);},0);
    const stampDigits=String(data.time||""),minute=/^\d{14}$/.test(stampDigits)?Number(stampDigits.slice(8,10))*60+Number(stampDigits.slice(10,12)):0;
    const progress=Math.max(.01,Math.min(1,minute<570?0.01:minute<=690?(minute-570)/240:minute<780?0.5:minute<=900?0.5+(minute-780)/240:1));
    const summary=dashboard.summary||{};dashboard.summary={...summary,amount_yi:amount,weighted_pct:weightedPct,active_net_yi:Number(data.net_yi)||activeNet,progress,ratio:summary.avg20_yi?amount/(Number(summary.avg20_yi)*progress):0};
    const stamp=data.time?timeLabel(data.time):"行情时间暂缺";
    const count=Number(data.quote_count)||data.items.length,total=Number(data.total_count)||dashboard.etfs.length;
    $("watchlist-update-time").textContent=`行情源 ${stamp} · ${count}/${total} 只更新；份额按交易所披露`;
    if(redraw){renderStatus();renderSummary();renderTable();}
  }
  async function refreshLiveFlow(){
    if(liveRefreshBusy)return;
    liveRefreshBusy=true;
    try{
      const r=await fetch("/api/live-flow",{cache:"no-store"}),data=await r.json();
      if(!r.ok)throw new Error(data.error||"实时估算暂不可用");
      liveFlow=data;applyLiveQuotes(data);renderLiveFlow();
    }catch(e){$("signal-title").textContent="实时估算暂不可用";$("signal-copy").textContent="行情接口未能返回完整的重点 ETF 报价；保留的数值属于上次成功采集，不能视为当前买卖。";$("metric-active-note").textContent=`实时行情暂不可用 · ${localClock()}`;$("live-update-time").textContent="本轮采集失败";$("live-source").textContent=liveFlow?.time?`上次成功行情源 ${timeLabel(liveFlow.time)}`:"尚无成功行情记录";$("watchlist-update-time").textContent=`实时行情暂不可用 · 保留上次报价（${localClock()} 检查失败）`;$("refresh-status").classList.add("offline");$("refresh-status").querySelector("span").textContent="实时估算连接失败";}finally{liveRefreshBusy=false;}
  }
  function pointsFor(days){const all=dashboard.history?.pool||[];return days>0?all.slice(-days):all;}
  function svgAxis(w,h,left,right,top,bottom,values,format){const innerH=h-top-bottom;return values.map((v,i)=>{const y=top+i/(values.length-1)*innerH;return `<line class="grid-line" x1="${left}" y1="${y}" x2="${w-right}" y2="${y}"/><text class="axis-label" x="2" y="${y+3}">${format(v)}</text>`;}).join("");}
  function dateTicks(points,w,left,right,h){if(!points.length)return "";const ids=[0,Math.floor((points.length-1)/3),Math.floor(2*(points.length-1)/3),points.length-1].filter((v,i,a)=>a.indexOf(v)===i);return ids.map((idx,i)=>{const x=left+(points.length===1?.5:idx/(points.length-1))*(w-left-right);return `<text class="axis-label" text-anchor="${i===0?"start":i===ids.length-1?"end":"middle"}" x="${x}" y="${h-3}">${dateLabel(points[idx].date).slice(5)}</text>`;}).join("");}
  function renderFlowChart(){
    const all=dashboard.history?.pool||[],p=pointsFor(poolRanges.flow).filter(x=>x.delta_yi!=null);$("flow-range-label").textContent=p.length?`${dateLabel(p[0].date)} — ${dateLabel(p[p.length-1].date)}`:"暂无完整份额变化";
    const last=p[p.length-1];$("flow-latest-label").textContent=last?`最新日 ${flowLabel(last.delta_yi)}`:"";
    if(!p.length){$("flow-chart").innerHTML='<div class="chart-empty">等待累计到至少两个交易日的重点池份额</div>';return;}
    const w=720,h=225,left=55,right=12,top=12,bottom=30,ih=h-top-bottom,vals=p.map(x=>Number(x.delta_yi)),max=Math.max(...vals.map(Math.abs),1),base=top+ih/2;
    const y=v=>base-v/max*(ih*.46),step=(w-left-right)/p.length,bw=Math.max(1,Math.min(9,step*.72));
    const ticks=[max,0,-max].map((v,i)=>{const yy=i===0?top+ih*.04:i===1?base:top+ih*.96;return `<line class="grid-line ${i===1?"zero-line":""}" x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}"/><text class="axis-label" x="2" y="${yy+3}">${signed(v,0)}</text>`;}).join("");
    const bars=p.map((v,i)=>{const x=left+i*step+(step-bw)/2,yy=y(v.delta_yi),height=Math.max(1,Math.abs(base-yy)),topY=Math.min(base,yy),bandX=left+i*step;return `<rect class="flow-hit" x="${bandX.toFixed(1)}" y="${top}" width="${Math.max(step,5).toFixed(1)}" height="${ih}" data-date="${v.date}" tabindex="0" role="button" aria-label="${dateLabel(v.date)} ${flowLabel(v.delta_yi)}"/><rect class="flow-bar ${Number(v.delta_yi)>=0?"inflow":"outflow"}${selectedFlowDate===v.date?" selected":""}" x="${x.toFixed(1)}" y="${topY.toFixed(1)}" width="${bw.toFixed(1)}" height="${height.toFixed(1)}" pointer-events="none"><title>${dateLabel(v.date)}：${flowLabel(v.delta_yi)}</title></rect>`;}).join("");
    $("flow-chart").innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${ticks}${bars}${dateTicks(p,w,left,right,h)}</svg>`;
  }
  function renderFlowDetailRows(){
    const d=currentFlowDetail;if(!d)return;
    const amountText=(value,coverage,count)=>value==null?"—":`${number(value,2)} 亿${count>coverage?`（${coverage}/${count} 只）`:""}`;
    const buyFirst=Number(d.net_yi)>0,sellFirst=Number(d.net_yi)<0;
    $("detail-sort-note").textContent=buyFirst?"当日合计为净申购，按净申购金额从高到低排列":sellFirst?"当日合计为净赎回，按净赎回金额从高到低排列":"当日净变化接近持平，按单只估算金额从高到低排列";
    const rows=[...d.items].sort((a,b)=>{
      const aBuy=Number(a.buy_amount_yi)||0,aSell=Number(a.sell_amount_yi)||0;
      const bBuy=Number(b.buy_amount_yi)||0,bSell=Number(b.sell_amount_yi)||0;
      const aAmount=buyFirst?aBuy:sellFirst?aSell:Math.max(aBuy,aSell);
      const bAmount=buyFirst?bBuy:sellFirst?bSell:Math.max(bBuy,bSell);
      return bAmount-aAmount||(Math.abs(Number(b.delta_yi)||0)-Math.abs(Number(a.delta_yi)||0))||String(a.code).localeCompare(String(b.code));
    });
    $("detail-rows").innerHTML=rows.map(i=>`<tr><td><div class="etf-name"><span><b>${esc(i.name)}</b><small>${esc(i.code)}</small></span></div></td><td class="right ${tone(i.delta_yi)} money">${i.delta_yi==null?"—":`${signed(i.delta_yi,2)} 亿份`}</td><td class="right pos money">${amountText(i.buy_amount_yi,i.buy_amount_yi==null?0:1,1)}</td><td class="right neg money">${amountText(i.sell_amount_yi,i.sell_amount_yi==null?0:1,1)}</td><td class="right money">${i.volume_yi==null?"—":`${number(i.volume_yi,2)} 亿份`}</td><td class="right money">${i.amount_yi==null?"—":`${number(i.amount_yi,2)} 亿`}</td></tr>`).join("");
  }
  async function showFlowDetail(date){
    selectedFlowDate=date;currentFlowDetail=null;renderFlowChart();const panel=$("flow-detail");panel.hidden=false;$("detail-date").textContent=`${dateLabel(date)} · 正在读取…`;$("detail-rows").innerHTML='<tr><td colspan="6" class="empty-row">正在读取所选日期的 ETF 明细…</td></tr>';
    try{
      const r=await fetch(`/api/flow-detail?date=${encodeURIComponent(date)}`,{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error||"读取失败");
      currentFlowDetail=d;$("detail-date").textContent=`${dateLabel(d.date)}${Number(d.basket_count)>Number(d.core_count)?` · ${d.core_count}/${d.basket_count} 只已披露`:""}${Number(d.fallback_count)>0?` · 含${d.fallback_count}只兜底`:""}`;$("detail-buy").textContent=d.buy_yi?flowLabel(d.buy_yi):"0.00 亿份";$("detail-sell").textContent=d.sell_yi?flowLabel(-d.sell_yi):"0.00 亿份";
      const estimateLabel=(value,coverage,count)=>value==null?"暂无完整估值":`${number(value,2)} 亿${count>coverage?`（${coverage}/${count} 只可估）`:""}`;
      $("detail-buy-amount").textContent=estimateLabel(d.buy_amount_yi,d.buy_amount_coverage,d.buy_count);
      $("detail-sell-amount").textContent=estimateLabel(d.sell_amount_yi,d.sell_amount_coverage,d.sell_count);
      $("detail-volume").textContent=d.volume_yi==null?"暂无成交量":`${number(d.volume_yi,2)} 亿份${d.volume_coverage<d.core_count?`（${d.volume_coverage}/${d.core_count} 只）`:""}`;
      $("detail-amount").textContent=d.amount_yi==null?"暂无成交额":`${number(d.amount_yi,2)} 亿元${d.amount_coverage<d.core_count?`（${d.amount_coverage}/${d.core_count} 只）`:""}`;
      renderFlowDetailRows();
    }catch(e){currentFlowDetail=null;$("detail-date").textContent=`${dateLabel(date)} · ${e.message}`;$("detail-rows").innerHTML='<tr><td colspan="6" class="empty-row">该日期暂无明细</td></tr>';}
  }
  function renderIndexChart(){
    const p=pointsFor(poolRanges.index);$("index-range-label").textContent=p.length?`${dateLabel(p[0].date)} — ${dateLabel(p[p.length-1].date)}`:"暂无份额历史";
    if(!p.length){$("index-latest-label").textContent="";$("index-chart").innerHTML='<div class="chart-empty">等待份额历史数据</div>';return;}
    const base=Number(p[0].shares_yi)||1,vals=p.map(x=>100*Number(x.shares_yi)/base),last=vals[vals.length-1];$("index-latest-label").textContent=`区间末 ${number(last,1)} · ${signed(last-100,1)}%`;
    const w=720,h=225,left=55,right=12,top=12,bottom=30,iw=w-left-right,ih=h-top-bottom,min=Math.min(...vals,100),max=Math.max(...vals,100),pad=Math.max((max-min)*.15,1),lo=min-pad,hi=max+pad;
    const y=v=>top+(hi-v)/(hi-lo)*ih,xy=vals.map((v,i)=>[left+(vals.length===1?iw/2:i/(vals.length-1)*iw),y(v)]),path=xy.map((v,i)=>`${i?"L":"M"}${v[0].toFixed(1)},${v[1].toFixed(1)}`).join(" ");
    const ticks=svgAxis(w,h,left,right,top,bottom,[hi,(hi+lo)/2,lo],v=>number(v,0));const y100=y(100);
    $("index-chart").innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line class="baseline-line" x1="${left}" y1="${y100}" x2="${w-right}" y2="${y100}"/><text class="axis-label" text-anchor="end" x="${w-right}" y="${y100-6}">基期 100</text>${ticks}<path class="pool-line" d="${path}"/><circle class="pool-point" cx="${xy.at(-1)[0]}" cy="${xy.at(-1)[1]}" r="3.7"/>${dateTicks(p,w,left,right,h)}</svg>`;
  }
  function renderPoolCharts(){renderFlowChart();renderIndexChart();}
  function renderPoolStats(){
    if(!poolStats.length){$("pool-stats-rows").innerHTML='<tr><td colspan="8" class="empty-row">所选区间暂无完整的汪汪队份额记录</td></tr>';$("pool-stats-count").textContent="0 个交易日";return;}
    const rows=[...poolStats].reverse();
    $("pool-stats-rows").innerHTML=rows.map(row=>{
      const delta=Number(row.shares_change_yi)||0,changeClass=delta>0?"flow-up":delta<0?"flow-down":"flow-flat";
      const buyText=row.buy_amount_yi==null?"—":`${number(row.buy_amount_yi,2)} 亿`;
      const sellText=row.sell_amount_yi==null?"—":`${number(row.sell_amount_yi,2)} 亿`;
      const netAmount=row.buy_amount_yi==null||row.sell_amount_yi==null?null:Number(row.buy_amount_yi)-Number(row.sell_amount_yi);
      const netClass=netAmount==null?"net-unknown":netAmount>0?"net-buy":netAmount<0?"net-sell":"net-flat";
      const netText=netAmount==null?"—":`${signed(netAmount,2)} 亿`;
      const coverage=Number(row.coverage_count)||0,basket=Number(row.basket_count)||coverage,fallback=Number(row.fallback_count)||0;
      const signal=`${delta>0?"估算净申购":delta<0?"估算净赎回":"份额持平"}${coverage<basket?` · ${coverage}/${basket} 只`:""}${fallback>0?` · 含${fallback}只兜底`:""}`;
      const turnover=row.turnover_multiple==null?"—":`${number(row.turnover_multiple,1)}×`;
      return `<tr class="stats-row ${changeClass}" data-date="${esc(row.date)}" tabindex="0" role="button" title="点击查看 ${shortDate(row.date)} 的 ETF 明细"><td class="stats-date">${esc(shortDate(row.date))}</td><td>${esc(row.pool_name)}</td><td class="right stats-tinted">${signed(delta,2)} 亿份</td><td class="right stats-buy ${Number(row.buy_amount_yi)>0?"active":""}">${buyText}</td><td class="right stats-sell ${Number(row.sell_amount_yi)>0?"active":""}">${sellText}</td><td class="right stats-net ${netClass}" title="买入总金额估算减去赎回总金额估算">${netText}</td><td class="right">${turnover}</td><td><span class="signal-tag">${signal}</span></td></tr>`;
    }).join("");
    $("pool-stats-count").textContent=`最近 ${rows.length} 个交易日 · 金额与成交量单位见列名`;
  }
  function renderTable(){
    const query=$("search").value.trim().toLowerCase(),scope=$("scope").value,sort=$("sort").value;
    let rows=(dashboard.etfs||[]).filter(i=>(scope==="all"||i.group===scope)&&(!query||[i.code,i.name,i.index].some(v=>String(v||"").toLowerCase().includes(query))));
    const active=i=>{const outer=Number(i.outer_lots)||0,inner=Number(i.inner_lots)||0,total=outer+inner;return total?((outer-inner)/total)*(Number(i.amount_yi)||0):0;};
    rows.sort((a,b)=>sort==="amount"?Number(b.amount_yi||0)-Number(a.amount_yi||0):sort==="ratio"?calcRatio(b)-calcRatio(a):sort==="change"?Number(b.pct||0)-Number(a.pct||0):sort==="huijin"?Number(b.huijin_yi||0)-Number(a.huijin_yi||0):Math.abs(active(b))-Math.abs(active(a)));
    if(!rows.length){$("etf-rows").innerHTML='<tr><td colspan="10" class="empty-row">没有匹配的 ETF</td></tr>';return;}
    const turnoverComparison=item=>{const data=(item.hist||[]).filter(point=>point.amount_yi!=null&&Number.isFinite(Number(point.amount_yi))).map(point=>({...point,date:String(point.date)}));const tradeDate=String(item.date||"");if(tradeDate&&item.amount_yi!=null){const existing=data.findIndex(point=>point.date.replaceAll("-","")===tradeDate.replaceAll("-",""));if(existing>=0)data[existing].amount_yi=Number(item.amount_yi);else data.push({date:tradeDate,amount_yi:Number(item.amount_yi)});}data.sort((a,b)=>a.date.localeCompare(b.date));const latest=data.at(-1),previous=data.at(-2);if(!latest)return '<div class="turnover-comparison empty">暂无成交额数据</div>';const change=previous?Number(latest.amount_yi)-Number(previous.amount_yi):null;return `<div class="turnover-comparison"><b>${number(latest.amount_yi,2)} 亿</b><small>${esc(shortDate(latest.date))}</small><small class="${change==null?"neutral":tone(change)}">${previous?`较 ${esc(shortDate(previous.date))} ${signed(change,2)} 亿`:"暂无前一有数据日"}</small></div>`;};
    const spark=item=>{const data=(item.hist||[]).slice(-30).filter(point=>Number.isFinite(Number(point.amount_yi)));if(!data.length)return '<span class="turnover-spark empty">暂无</span>';const max=Math.max(...data.map(point=>Number(point.amount_yi)),.01);return `<span class="turnover-spark" aria-label="近30日成交额走势">${data.map((point,index)=>`<i class="${index===data.length-1?`latest ${tone(item.pct)}`:""}" style="height:${Math.max(4,Math.round(Number(point.amount_yi)/max*28))}px" title="${esc(shortDate(point.date))} ${number(point.amount_yi,2)} 亿"></i>`).join("")}</span>`;};
    $("etf-rows").innerHTML=rows.map(item=>{const ratio=calcRatio(item),activeNet=active(item),tag=item.group==="core"?'<span class="tag">汪汪队</span>':'<span class="tag tag-watch">扩展</span>';return `<tr><td><div class="etf-name"><span><b>${esc(item.name)} ${tag}</b><small>${esc(item.code)}</small></span></div></td><td>${esc(item.index||"—")}</td><td class="right money">${number(item.mktcap_yi,1)}</td><td class="right money">${number(item.amount_yi,2)}</td><td class="right money">${number(ratio,2)}×</td><td class="right ${tone(activeNet)} money">${signed(activeNet,2)} 亿</td><td class="right ${tone(item.pct)} money">${signed(item.pct,2)}%</td><td>${turnoverComparison(item)}</td><td>${spark(item)}</td><td class="right holding">${item.huijin_yi==null?"—":`${number(item.huijin_yi,1)} 亿份`}</td></tr>`;}).join("");
    $("table-count").textContent=`显示 ${rows.length} / ${dashboard.etfs.length} 只 ETF`;
  }
  function calcRatio(i){const base=Number(i.avg20_yi)||0,progress=Number(i.day_progress)||1;return base>0?Number(i.amount_yi||0)/(base*Math.max(progress,.0001)):0;}
  async function refreshNow(quiet=false){const button=$("refresh"),status=$("refresh-status");if(button.dataset.busy==="true")return;button.dataset.busy="true";button.disabled=true;button.querySelector("span").textContent="更新中…";status.classList.add("updating");status.querySelector("span").textContent="正在检查行情…";try{const r=await fetch("/api/update",{method:"POST"}),result=await r.json();if(result.live_flow){liveFlow=result.live_flow;applyLiveQuotes(liveFlow);renderLiveFlow();}await loadDashboard();if(result.status==="skipped"&&result.message==="已有更新任务运行中"){await new Promise(resolve=>setTimeout(resolve,1800));await loadDashboard();}if(result.status==="failed"){status.classList.add("offline");status.querySelector("span").textContent=`数据检查失败 · ${localClock()}`;}else{status.classList.remove("offline");status.querySelector("span").textContent=`数据检查完成 · ${localClock()}`;}if(!quiet)toast(result.message||"已完成",result.status==="failed");}catch(e){status.classList.add("offline");status.querySelector("span").textContent=`数据检查失败 · ${localClock()}`;if(!quiet)toast(e.message||"更新失败",true);}finally{button.dataset.busy="false";button.disabled=false;button.querySelector("span").textContent="立即更新";status.classList.remove("updating");}}
  $("refresh").addEventListener("click",()=>refreshNow(false));
  $("flow-chart").addEventListener("click",event=>{const hit=event.target.closest(".flow-hit");if(hit)showFlowDetail(hit.dataset.date);});
  $("flow-chart").addEventListener("keydown",event=>{const hit=event.target.closest(".flow-hit");if(hit&&(event.key==="Enter"||event.key===" ")){event.preventDefault();showFlowDetail(hit.dataset.date);}});
  $("detail-close").addEventListener("click",()=>{$("flow-detail").hidden=true;selectedFlowDate=null;renderFlowChart();});
  document.querySelectorAll(".pool-range button").forEach(button=>button.addEventListener("click",()=>{const chart=button.dataset.pool;poolRanges[chart]=Number(button.dataset.days);button.parentElement.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b===button));renderPoolCharts();}));
  document.querySelectorAll(".stats-range button").forEach(button=>button.addEventListener("click",async()=>{statsDays=Number(button.dataset.statsDays);button.parentElement.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b===button));try{const r=await fetch(`/api/pool-stats?days=${statsDays}`,{cache:"no-store"}),data=await r.json();if(!r.ok)throw new Error(data.error||"读取统计失败");poolStats=data.rows||[];renderPoolStats();}catch(e){toast(e.message,true);}}));
  $("pool-stats-rows").addEventListener("click",event=>{const row=event.target.closest("tr[data-date]");if(!row)return;showFlowDetail(row.dataset.date).then(()=>$("flow-detail").scrollIntoView({behavior:"smooth",block:"center"}));});
  $("pool-stats-rows").addEventListener("keydown",event=>{const row=event.target.closest("tr[data-date]");if(row&&(event.key==="Enter"||event.key===" ")){event.preventDefault();row.click();}});
  $("search").addEventListener("input",renderTable);$("scope").addEventListener("change",renderTable);$("sort").addEventListener("change",renderTable);
  $("turnover-etf-select").addEventListener("change",event=>{turnoverSelection=event.target.value;renderLiveTurnoverChart();});
  loadDashboard().then(()=>refreshNow(true)).catch(e=>{$("signal-title").textContent="数据暂时不可用";$("signal-copy").textContent=e.message;$("etf-rows").innerHTML=`<tr><td colspan="10" class="empty-row">${esc(e.message)}</td></tr>`;toast(e.message,true);});
  refreshLiveFlow();
  refreshLiveTurnover();
  setInterval(refreshLiveFlow,20000);
  setInterval(refreshLiveTurnover,20000);
  const refreshPersistedData=async()=>{if(document.hidden||dashboardRefreshBusy)return;dashboardRefreshBusy=true;try{await loadDashboard();}catch(error){console.warn("定时读取统计数据失败",error);}finally{dashboardRefreshBusy=false;}};
  setInterval(refreshPersistedData,60000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){refreshPersistedData();refreshLiveFlow();}});
})();
