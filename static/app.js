(() => {
  const $ = (id) => document.getElementById(id);
  let dashboard = null;
  let poolRanges = {flow: 60, index: 240};
  let statsDays = 20;
  let poolStats = [];
  let liveFlow = null;
  let selectedFlowDate = null;
  let toastTimer = null;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const number = (v,d=1) => Number.isFinite(Number(v)) ? Number(v).toLocaleString("zh-CN",{minimumFractionDigits:d,maximumFractionDigits:d}) : "—";
  const signed = (v,d=1) => `${Number(v)>0?"+":Number(v)<0?"−":""}${number(Math.abs(Number(v)||0),d)}`;
  const flowLabel = v => Math.abs(Number(v)||0)<0.01?`${signed((Number(v)||0)*1e8,0)} 份`:`${signed(v,2)} 亿份`;
  const tone = v => Number(v)>0?"pos":Number(v)<0?"neg":"neutral";
  const dateLabel = v => {const s=String(v||"").replaceAll("-","");return /^\d{8}$/.test(s)?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:(v||"—");};
  const shortDate = v => {const s=String(v||"").replaceAll("-","");return /^\d{8}$/.test(s)?`${Number(s.slice(4,6))}月${Number(s.slice(6,8))}日`:(v||"—");};
  const timeLabel = v => {if(!v)return "—";const s=String(v);if(/^\d{14}$/.test(s))return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}`;if(s.endsWith("Z"))return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(s));return s.replace("T"," ").slice(0,16);};
  const localClock = () => new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false,timeZone:"Asia/Shanghai"}).format(new Date());
  function toast(message,isError=false){const el=$("toast");el.textContent=message;el.className=`toast show${isError?" error":""}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className="toast",3800);}
  async function loadDashboard(){const [r,s]=await Promise.all([fetch("/api/dashboard",{cache:"no-store"}),fetch(`/api/pool-stats?days=${statsDays}`,{cache:"no-store"})]);if(!r.ok)throw new Error(`数据读取失败（${r.status}）`);dashboard=await r.json();if(!dashboard.etfs?.length)throw new Error(dashboard.error||"数据库中没有 ETF 快照");if(s.ok){const data=await s.json();poolStats=data.rows||[];}else poolStats=[];render();}
  function render(){renderStatus();renderSummary();renderPoolCharts();renderPoolStats();renderTable();}
  function renderStatus(){
    const run=dashboard.latest_run,newest=dashboard.etfs[0];
    const cloud=dashboard.runtime==="cloudflare";
    $("asof-date").textContent=dateLabel(dashboard.trade_date||newest?.date);
    $("asof-time").textContent=`行情时间 ${timeLabel(newest?.source_ts||newest?.ts)}`;
    $("source-line").textContent=`${dashboard.source||"公开行情"} · ${cloud?"Cloudflare D1":"SQLite 本地保存"}`;
    $("footer-source").textContent=`${dashboard.source||"公开行情"} · ${cloud?"Cloudflare D1":"数据保存于本机"}`;
    const conn=$("connection"),state=$("market-state"),fresh=$("freshness");
    const workerRun=run?.source==="Cloudflare Worker Cron";
    const failed=run?.status==="failed"&&(!cloud||workerRun);
    conn.classList.toggle("offline",Boolean(failed));
    conn.querySelector("span").textContent=cloud?"Cloudflare D1":"本地 SQLite";
    state.textContent=failed?`${cloud?"云端":"本地"}最近一次采集失败`:"资金观察台";
    fresh.textContent=failed?"仍显示最近完整确认数据":cloud?"盘中行情每 20 秒刷新":run?.finished_at?`最近本地采集 ${timeLabel(run.finished_at)}`:"等待首次采集";
    if(cloud&&!workerRun){$("collection-last-run").textContent="云端定时任务等待首次执行";}
    else if(run){
      const label=run.status==="failed"?"采集失败":run.message?.includes("官方份额未齐")?"行情已更新，官方份额待发布":"采集成功";
      $("collection-last-run").textContent=`${cloud?"云端":"本地"}${label} · ${timeLabel(run.finished_at)}`;
    }else $("collection-last-run").textContent="尚无采集记录";
    const confirmed=(dashboard.history?.pool||[]).filter(row=>row.delta_yi!=null).at(-1)?.date;
    $("share-data-date").textContent=confirmed?`最新完整确认份额：${dateLabel(confirmed)}`:"尚无完整确认份额记录";
  }
  function renderSummary(){
    const s=dashboard.summary||{},ratio=Number(s.ratio)||0;
    const ready=Number(s.amount_yi)>0&&Number(s.avg20_yi)>0;
    $("signal-title").textContent=!ready?"等待当日成交数据":ratio>=1.8?"观察到资金活跃迹象":ratio>=1.3?"成交有所活跃，方向待观察":"暂未看到明显介入迹象";
    $("signal-copy").textContent=ready?`核心池成交额约为历史同时点基线的 ${number(ratio,2)} 倍。份额与成交方向都是代理信号，不能确认具体交易账户。`:"当日成交数据尚未齐备，暂不生成资金活跃判断。";
    $("signal-scope").textContent=`CORE ${s.core_count||20}`;
    $("scope-label").textContent=`${s.core_count||20} 只宽基 · ${Math.max(0,(s.total_count||24)-(s.core_count||20))} 只扩展`;
    $("today-signal-meter").style.width=`${Math.min(100,Math.max(0,ratio/2.5*100))}%`;
    $("metric-ratio").textContent=`${number(s.ratio,2)}×`;$("metric-ratio-note").textContent=`${number((s.progress||0)*100,0)}% 历史成交进度已完成`;$("ratio-meter").style.width=`${Math.min(100,Math.max(0,(Number(s.ratio)||0)/2.5*100))}%`;
    $("metric-amount").textContent=`${number(s.amount_yi,1)} 亿`;$("metric-avg").textContent=`20 日均额 ${number(s.avg20_yi,1)} 亿`;
    $("metric-change").textContent=`${signed(s.weighted_pct,2)}%`;$("metric-change").className=`metric-value ${tone(s.weighted_pct)}`;$("metric-active").textContent=`${signed(s.active_net_yi,1)} 亿`;$("metric-active").className=`metric-value ${tone(s.active_net_yi)}`;
    $("table-count").textContent=`${s.total_count||0} 只 ETF · 重点 ${s.core_count||0} 只`;
  }
  function renderLiveFlow(){
    if(!liveFlow)return;
    const stamp=String(liveFlow.time||"");
    const clock=stamp.length>=12?`${stamp.slice(8,10)}:${stamp.slice(10,12)}`:localClock();
    $("metric-active").textContent=`${signed(liveFlow.net_yi,1)} 亿`;
    $("metric-active").className=`metric-value ${tone(liveFlow.net_yi)}`;
    $("metric-active-note").textContent=`内外盘成交方向估算 · ${liveFlow.core_count} 只重点 ETF`;
    $("live-update-label").textContent="盘中主动买卖估算 · 每 20 秒刷新";
    $("live-update-time").textContent=`${dateLabel(liveFlow.date)} ${clock}`;
    $("refresh-status").classList.remove("offline");
    $("refresh-status").querySelector("span").textContent=`行情 ${clock}`;
  }
  async function refreshLiveFlow(){
    try{
      const r=await fetch("/api/live-flow",{cache:"no-store"}),data=await r.json();
      if(!r.ok)throw new Error(data.error||"实时估算暂不可用");
      liveFlow=data;renderLiveFlow();
    }catch(e){$("metric-active-note").textContent=`实时行情暂不可用 · ${localClock()}`;$("live-update-time").textContent="行情暂不可用";$("refresh-status").classList.add("offline");$("refresh-status").querySelector("span").textContent="实时行情连接失败";}
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
  async function showFlowDetail(date){
    selectedFlowDate=date;renderFlowChart();const panel=$("flow-detail");panel.hidden=false;$("detail-date").textContent=`${dateLabel(date)} · 正在读取…`;
    try{
      const r=await fetch(`/api/flow-detail?date=${encodeURIComponent(date)}`,{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error||"读取失败");
      $("detail-date").textContent=dateLabel(d.date);$("detail-buy").textContent=d.buy_yi?flowLabel(d.buy_yi):"0 份";$("detail-sell").textContent=d.sell_yi?flowLabel(-d.sell_yi):"0 份";
      $("detail-volume").textContent=d.volume_yi==null?"暂无成交量":`${number(d.volume_yi,2)} 亿份${d.volume_coverage<d.core_count?`（${d.volume_coverage}/${d.core_count} 只）`:""}`;
      $("detail-amount").textContent=d.amount_yi==null?"暂无成交额":`${number(d.amount_yi,2)} 亿元${d.amount_coverage<d.core_count?`（${d.amount_coverage}/${d.core_count} 只）`:""}`;
      $("detail-rows").innerHTML=d.items.map(i=>`<tr><td><div class="etf-name"><span><b>${esc(i.name)}</b><small>${esc(i.code)}</small></span></div></td><td class="right ${tone(i.delta_yi)} money">${i.delta_yi==null?"—":flowLabel(i.delta_yi)}</td><td class="right money">${i.volume_yi==null?"—":`${number(i.volume_yi,2)} 亿份`}</td><td class="right money">${i.amount_yi==null?"—":`${number(i.amount_yi,2)} 亿`}</td></tr>`).join("");
    }catch(e){$("detail-date").textContent=`${dateLabel(date)} · ${e.message}`;$("detail-rows").innerHTML='<tr><td colspan="4" class="empty-row">该日期暂无明细</td></tr>';}
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
    if(!poolStats.length){$("pool-stats-rows").innerHTML='<tr><td colspan="7" class="empty-row">所选区间暂无完整的汪汪队份额记录</td></tr>';$("pool-stats-count").textContent="0 个交易日";return;}
    const rows=[...poolStats].reverse();
    $("pool-stats-rows").innerHTML=rows.map(row=>{
      const delta=Number(row.shares_change_yi)||0,changeClass=delta>0?"flow-up":delta<0?"flow-down":"flow-flat";
      const buyText=row.buy_amount_yi==null?"—":`${number(row.buy_amount_yi,2)} 亿`;
      const sellText=row.sell_amount_yi==null?"—":`${number(row.sell_amount_yi,2)} 亿`;
      const signal=delta>0?"估算净申购":delta<0?"估算净赎回":"份额持平";
      const turnover=row.turnover_multiple==null?"—":`${number(row.turnover_multiple,1)}×`;
      return `<tr class="stats-row ${changeClass}" data-date="${esc(row.date)}" tabindex="0" role="button" title="点击查看 ${shortDate(row.date)} 的 ETF 明细"><td class="stats-date">${esc(shortDate(row.date))}</td><td>${esc(row.pool_name)}</td><td class="right stats-tinted">${signed(delta,2)} 亿份</td><td class="right stats-buy ${Number(row.buy_amount_yi)>0?"active":""}">${buyText}</td><td class="right stats-sell ${Number(row.sell_amount_yi)>0?"active":""}">${sellText}</td><td class="right">${turnover}</td><td><span class="signal-tag">${signal}</span></td></tr>`;
    }).join("");
    $("pool-stats-count").textContent=`最近 ${rows.length} 个交易日 · 金额与成交量单位见列名`;
  }
  function renderTable(){
    const query=$("search").value.trim().toLowerCase(),scope=$("scope").value,sort=$("sort").value;
    let rows=(dashboard.etfs||[]).filter(i=>(scope==="all"||i.group===scope)&&(!query||[i.code,i.name,i.index].some(v=>String(v||"").toLowerCase().includes(query))));
    const flow=i=>Number(i.subscr_net_yi)||0;rows.sort((a,b)=>sort==="amount"?Number(b.amount_yi||0)-Number(a.amount_yi||0):sort==="ratio"?calcRatio(b)-calcRatio(a):sort==="change"?Number(b.pct||0)-Number(a.pct||0):sort==="huijin"?Number(b.huijin_yi||0)-Number(a.huijin_yi||0):flow(b)-flow(a));
    if(!rows.length){$("etf-rows").innerHTML='<tr><td colspan="8" class="empty-row">没有匹配的 ETF</td></tr>';return;}
    $("etf-rows").innerHTML=rows.map(item=>{const ratio=calcRatio(item),net=item.subscr_net_yi,span=item.prev_share_date?`<span class="subnote">自 ${esc(dateLabel(item.prev_share_date))}</span>`:"",label=item.group==="core"?'<span class="tag">重点</span>':'<span class="tag tag-watch">对照</span>';return `<tr><td><div class="etf-name"><span class="mini-mark">ETF</span><span><b>${esc(item.name)}</b><small>${esc(item.code)}</small></span></div></td><td>${esc(item.index||"—")}</td><td>${label}</td><td class="right ${tone(item.pct)} money">${signed(item.pct,2)}%</td><td class="right money">${number(item.amount_yi,2)}</td><td class="right money">${number(ratio,2)}×</td><td class="right ${net==null?"neutral":tone(net)} money">${net==null?"—":`${signed(net,2)} 亿`}${span}</td><td class="right holding">${item.huijin_yi==null?"—":`${number(item.huijin_yi,1)} 亿份`}</td></tr>`;}).join("");
    $("table-count").textContent=`显示 ${rows.length} / ${dashboard.etfs.length} 只 ETF`;
  }
  function calcRatio(i){const base=Number(i.avg20_yi)||0,progress=Number(i.day_progress)||1;return base>0?Number(i.amount_yi||0)/(base*Math.max(progress,.0001)):0;}
  async function refreshNow(quiet=false){const button=$("refresh"),status=$("refresh-status");if(button.dataset.busy==="true")return;button.dataset.busy="true";button.disabled=true;button.querySelector("span").textContent="更新中…";status.classList.add("updating");status.querySelector("span").textContent="正在检查行情…";try{const r=await fetch("/api/update",{method:"POST"}),result=await r.json();await loadDashboard();if(result.status==="skipped"&&result.message==="已有更新任务运行中"){await new Promise(resolve=>setTimeout(resolve,1800));await loadDashboard();}if(result.status==="failed"){status.classList.add("offline");status.querySelector("span").textContent=`数据检查失败 · ${localClock()}`;}else{status.classList.remove("offline");status.querySelector("span").textContent=`数据检查完成 · ${localClock()}`;}if(!quiet)toast(result.message||"已完成",result.status==="failed");}catch(e){status.classList.add("offline");status.querySelector("span").textContent=`数据检查失败 · ${localClock()}`;if(!quiet)toast(e.message||"更新失败",true);}finally{button.dataset.busy="false";button.disabled=false;button.querySelector("span").textContent="立即更新";status.classList.remove("updating");}}
  $("refresh").addEventListener("click",()=>refreshNow(false));
  $("flow-chart").addEventListener("click",event=>{const hit=event.target.closest(".flow-hit");if(hit)showFlowDetail(hit.dataset.date);});
  $("flow-chart").addEventListener("keydown",event=>{const hit=event.target.closest(".flow-hit");if(hit&&(event.key==="Enter"||event.key===" ")){event.preventDefault();showFlowDetail(hit.dataset.date);}});
  $("detail-close").addEventListener("click",()=>{$("flow-detail").hidden=true;selectedFlowDate=null;renderFlowChart();});
  document.querySelectorAll(".pool-range button").forEach(button=>button.addEventListener("click",()=>{const chart=button.dataset.pool;poolRanges[chart]=Number(button.dataset.days);button.parentElement.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b===button));renderPoolCharts();}));
  document.querySelectorAll(".stats-range button").forEach(button=>button.addEventListener("click",async()=>{statsDays=Number(button.dataset.statsDays);button.parentElement.querySelectorAll("button").forEach(b=>b.classList.toggle("active",b===button));try{const r=await fetch(`/api/pool-stats?days=${statsDays}`,{cache:"no-store"}),data=await r.json();if(!r.ok)throw new Error(data.error||"读取统计失败");poolStats=data.rows||[];renderPoolStats();}catch(e){toast(e.message,true);}}));
  $("pool-stats-rows").addEventListener("click",event=>{const row=event.target.closest("tr[data-date]");if(!row)return;showFlowDetail(row.dataset.date).then(()=>$("flow-detail").scrollIntoView({behavior:"smooth",block:"center"}));});
  $("pool-stats-rows").addEventListener("keydown",event=>{const row=event.target.closest("tr[data-date]");if(row&&(event.key==="Enter"||event.key===" ")){event.preventDefault();row.click();}});
  $("search").addEventListener("input",renderTable);$("scope").addEventListener("change",renderTable);$("sort").addEventListener("change",renderTable);
  loadDashboard().then(()=>refreshNow(true)).catch(e=>{$("signal-title").textContent="数据暂时不可用";$("signal-copy").textContent=e.message;$("etf-rows").innerHTML=`<tr><td colspan="8" class="empty-row">${esc(e.message)}</td></tr>`;toast(e.message,true);});
  refreshLiveFlow();
  setInterval(refreshLiveFlow,20000);
})();
