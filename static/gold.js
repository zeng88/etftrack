(() => {
  const $ = id => document.getElementById(id);
  const chart = $("gold-chart"), detail = $("gold-detail"), cache = new Map();
  const base = "https://xaus.com/api/v1/";
  const paths = {intraday:"intraday?symbol=xau&hours=24",daily:"chart?symbol=xau&range=2y&interval=1d",monthly:"chart?symbol=xau&range=10y&interval=1mo"};
  const labels = {intraday:"北京时间当日 · 5 分钟采样",day:"日K线 · 近一年",week:"周K线 · 近两年",month:"月K线 · 近五年",year:"年K线 · 近十年"};
  let unit="cny", range="intraday", quote=null, points=[], requestId=0, lastRender=null;
  const format = (n,d=2) => Number(n).toLocaleString("zh-CN",{minimumFractionDigits:d,maximumFractionDigits:d});
  const timestamp = (value,options={}) => new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,...options}).format(new Date(value));
  const price = value => unit==="cny" ? value*Number(quote.fx_rate)/31.1034768 : value;
  const unitLabel = () => unit==="cny" ? "元 / 克" : "美元 / 金衡盎司";
  // Shanghai does not observe daylight saving time. Anchor the chart to the
  // actual Beijing calendar day, independent of the viewer's local timezone.
  const beijingDayStart = time => Math.floor((time+8*3600000)/86400000)*86400000-8*3600000;
  async function get(path,ttl){
    const hit=cache.get(path);if(hit && Date.now()-hit.time<ttl)return hit.data;
    const response=await fetch(base+path,{signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error(`行情源暂不可用（${response.status}）`);
    const data=await response.json();cache.set(path,{time:Date.now(),data});return data;
  }
  function normalize(rows){
    return (rows||[]).map(p=>({time:Number(p.t)*1000,open:Number(p.o),high:Number(p.h),low:Number(p.l),close:Number(p.c)}))
      .filter(p=>Number.isFinite(p.time)&&p.time>0&&[p.open,p.high,p.low,p.close].every(v=>Number.isFinite(v)&&v>0)&&p.high>=Math.max(p.open,p.close,p.low)&&p.low<=Math.min(p.open,p.close,p.high))
      .sort((a,b)=>a.time-b.time);
  }
  function bucket(time,period){
    const d=new Date(time),year=d.getUTCFullYear(),month=d.getUTCMonth(),day=d.getUTCDate();
    if(period==="week"){const start=new Date(Date.UTC(year,month,day));start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);return start.getTime();}
    if(period==="month")return Date.UTC(year,month,1);
    return Date.UTC(year,0,1);
  }
  function aggregate(rows,period){
    const groups=new Map();for(const p of rows){const key=bucket(p.time,period),old=groups.get(key);if(old){old.high=Math.max(old.high,p.high);old.low=Math.min(old.low,p.low);old.close=p.close;}else groups.set(key,{time:key,open:p.open,high:p.high,low:p.low,close:p.close});}return [...groups.values()].sort((a,b)=>a.time-b.time);
  }
  function candleSeries(daily,monthly,selected){
    if(selected==="day")return daily.slice(-252);
    if(selected==="week")return aggregate(daily,"week").slice(-104);
    // XAUS may append a current-day candle as its final monthly candle. Use
    // completed months only, then construct the current month from daily bars.
    const currentMonth=bucket(daily.at(-1).time,"month");
    const completed=monthly.filter(p=>bucket(p.time,"month")<currentMonth);
    const current=aggregate(daily.filter(p=>bucket(p.time,"month")===currentMonth),"month");
    const months=[...completed,...current];
    if(selected==="month")return months.slice(-60);
    const years=aggregate(months,"year");
    // The first requested month can be mid-year, so exclude that partial year.
    if(months.length&&new Date(months[0].time).getUTCMonth()!==0)years.shift();
    return years.slice(-10);
  }
  function pointLabel(point){
    if(range==="intraday")return timestamp(point.time,{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
    const d=new Date(point.time),y=d.getUTCFullYear(),m=String(d.getUTCMonth()+1).padStart(2,"0"),day=String(d.getUTCDate()).padStart(2,"0");
    return range==="year"?`${y}年`:range==="month"?`${y}-${m}`:range==="week"?`${y}-${m}-${day} 起`:`${y}-${m}-${day}`;
  }
  function describe(point){
    if(range==="intraday"){detail.textContent=`${pointLabel(point)} · ${format(price(point.close))} ${unitLabel()}`;return;}
    detail.innerHTML=`<strong>${pointLabel(point)}</strong><span>开盘 <b>${format(price(point.open))}</b></span><span>最高 <b>${format(price(point.high))}</b></span><span>最低 <b>${format(price(point.low))}</b></span><span>收盘 <b>${format(price(point.close))}</b></span><small>${unitLabel()} · 红涨绿跌</small>`;
  }
  function draw(){
    if(!quote||!points.length)return;
    const w=1000,h=230,left=68,right=18,top=15,bottom=32,candles=range!=="intraday";
    const lows=points.map(p=>price(candles?p.low:p.close)),highs=points.map(p=>price(candles?p.high:p.close));
    let low=Math.min(...lows),high=Math.max(...highs);const pad=Math.max((high-low)*.12,high*.0005);low-=pad;high+=pad;
    const start=candles?points[0].time:beijingDayStart(Date.now()),end=candles?points.at(-1).time:start+86400000,span=Math.max(end-start,1),width=w-left-right;
    const x=(p,i)=>candles?left+(i+.5)*width/points.length:left+(p.time-start)/span*width;
    const y=value=>top+(high-value)/(high-low)*(h-top-bottom);
    const grid=Array.from({length:5},(_,i)=>{const value=high-(high-low)*i/4,at=y(value);return `<line x1="${left}" y1="${at}" x2="${w-right}" y2="${at}"/><text x="${left-9}" y="${at+4}" text-anchor="end">${format(value)}</text>`;}).join("");
    const ticks=(candles?[0,.5,1]:[0,.25,.5,.75,1]).map(p=>{const index=Math.round(p*(points.length-1)),label=candles?pointLabel(points[index]):`${String(p*24).padStart(2,"0")}:00`;return `<text x="${left+p*width}" y="${h-5}" text-anchor="${p===0?"start":p===1?"end":"middle"}">${label}</text>`;}).join("");
    let drawing;
    if(candles){
      const barWidth=Math.max(1,Math.min(12,width/points.length*.68));
      drawing=points.map((p,i)=>{const cx=x(p,i),open=y(price(p.open)),close=y(price(p.close)),rising=p.close>=p.open,barY=Math.min(open,close),barHeight=Math.max(1,Math.abs(open-close));return `<g class="gold-candle ${rising?"up":"down"}"><line x1="${cx}" x2="${cx}" y1="${y(price(p.high))}" y2="${y(price(p.low))}"/><rect x="${cx-barWidth/2}" y="${barY}" width="${barWidth}" height="${barHeight}"/></g>`;}).join("");
    }else{
      const path=points.map((p,i)=>`${i?"L":"M"}${x(p,i).toFixed(2)},${y(price(p.close)).toFixed(2)}`).join(" ");
      drawing=`<path class="gold-area" d="${path} L${x(points.at(-1),points.length-1)} ${h-bottom} L${x(points[0],0)} ${h-bottom} Z"/><path class="gold-line" d="${path}"/><circle class="gold-dot" cx="${x(points.at(-1),points.length-1)}" cy="${y(price(points.at(-1).close))}" r="4"/>`;
    }
    chart.innerHTML=`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${labels[range]}黄金价格走势"><defs><linearGradient id="gold-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c39a4a" stop-opacity=".22"/><stop offset="1" stop-color="#c39a4a" stop-opacity="0"/></linearGradient></defs><g class="gold-grid">${grid}${ticks}</g>${drawing}</svg>`;
    lastRender={w,left,right,start,end,candles};describe(points.at(-1));
  }
  function showPoint(event){
    if(!lastRender||!points.length)return;const rect=chart.getBoundingClientRect(),{w,left,right,start,end,candles}=lastRender;
    const at=Math.max(0,Math.min(1,((event.clientX-rect.left)/rect.width*w-left)/(w-left-right)));
    if(candles){describe(points[Math.min(points.length-1,Math.floor(at*points.length))]);return;}
    const target=start+(end-start)*at;if(target<points[0].time||target>points.at(-1).time){detail.textContent="该时刻暂无行情数据";return;}let index=0;while(index<points.length-1&&Math.abs(points[index+1].time-target)<=Math.abs(points[index].time-target))index++;describe(points[index]);
  }
  async function refresh(){
    const id=++requestId,selected=range;
    try{
      const [spot,series,monthly]=await Promise.all([get("spot?currency=CNY&unit=gram&compact=1",60000),get(selected==="intraday"?paths.intraday:paths.daily,300000),selected==="month"||selected==="year"?get(paths.monthly,300000):Promise.resolve(null)]);
      if(id!==requestId)return;
      if(!(Number(spot.spot_usd_oz)>0&&Number(spot.fx_rate)>0))throw new Error("黄金报价或汇率缺失");
      let parsed;
      if(selected==="intraday"){const now=Date.now(),dayStart=beijingDayStart(now);parsed=(series.points||[]).map(p=>({time:Number(p.t)*1000,close:Number(p.p)})).filter(p=>Number.isFinite(p.time)&&p.time>=dayStart&&p.time<=now&&Number.isFinite(p.close)&&p.close>0).sort((a,b)=>a.time-b.time);}
      else{const daily=normalize(series.points),months=monthly?normalize(monthly.points):[];if(daily.length<2||((selected==="month"||selected==="year")&&!months.length))throw new Error("黄金K线数据不足");parsed=candleSeries(daily,months,selected);}
      if(parsed.length<(selected==="intraday"?1:2))throw new Error(selected==="intraday"?"北京时间今日暂无黄金分时数据":"黄金走势数据不足");
      quote=spot;points=parsed;
      $("gold-price-label").textContent=unit==="cny"?"国际金价 · 人民币折算":"国际金价 · 伦敦金现货";
      $("gold-price").textContent=format(unit==="cny"?Number(spot.xau?.price):spot.spot_usd_oz);
      $("gold-price-unit").textContent=unitLabel();
      const asOf=spot.data_state?.as_of||spot.price_as_of||spot.updated_at,age=Date.now()-Date.parse(asOf),stale=spot.data_state?.status!=="fresh"||!Number.isFinite(age)||age>5*60*1000;
      $("gold-freshness").textContent=`${stale?"可能延迟":"参考报价"} · ${asOf?timestamp(asOf,{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"时间未知"}（北京时间）`;
      $("gold-fx").textContent=`1 美元 ≈ ${format(spot.fx_rate,4)} 元${spot.fx_stale?" · 汇率可能延迟":""}`;
      draw();
    }catch(error){if(id!==requestId)return;quote=null;points=[];lastRender=null;chart.textContent=error instanceof Error?error.message:"黄金行情暂不可用";chart.classList.add("gold-error");$("gold-price").textContent="—";$("gold-freshness").textContent="行情暂不可用，请稍后重试";detail.textContent="暂无法显示黄金走势";return;}
    chart.classList.remove("gold-error");
  }
  document.querySelectorAll("[data-gold-unit]").forEach(button=>button.addEventListener("click",()=>{unit=button.dataset.goldUnit;document.querySelectorAll("[data-gold-unit]").forEach(el=>el.setAttribute("aria-pressed",String(el===button)));refresh();}));
  document.querySelectorAll("[data-gold-range]").forEach(button=>button.addEventListener("click",()=>{range=button.dataset.goldRange;document.querySelectorAll("[data-gold-range]").forEach(el=>el.setAttribute("aria-pressed",String(el===button)));chart.textContent="正在读取黄金走势…";refresh();}));
  chart.addEventListener("pointermove",showPoint);chart.addEventListener("click",showPoint);
  refresh();setInterval(()=>{if(!document.hidden)refresh();},60000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refresh();});
})();
