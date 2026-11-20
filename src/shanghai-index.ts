const TENCENT_URL="https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,320,qfq";
const SINA_URL="https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh000001&scale=240&datalen=320";

type IndexRow = {date:string;open:number;close:number};

export function parseIndexRows(payload:unknown, source:"tencent"|"sina"):IndexRow[]{
  const data=payload as any;
  const values=source==="tencent"?data?.data?.sh000001?.day:data;
  if(!Array.isArray(values))throw new Error("上证指数行情格式异常");
  const rows=values.map((row:any)=>({date:String(source==="tencent"?row?.[0]:row?.day||"").replaceAll("-",""),open:Number(source==="tencent"?row?.[1]:row?.open),close:Number(source==="tencent"?row?.[2]:row?.close)}))
    .filter((row:IndexRow)=>/^\d{8}$/.test(row.date)&&Number.isFinite(row.open)&&row.open>0&&Number.isFinite(row.close)&&row.close>0);
  if(!rows.length)throw new Error("上证指数行情为空");
  return rows;
}

export async function fetchShanghaiIndex(){
  for(const [source,url] of [["tencent",TENCENT_URL],["sina",SINA_URL]] as const){
    try{const response=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0",Referer:"https://finance.sina.com.cn/"},signal:AbortSignal.timeout(6000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);return {source:source==="tencent"?"腾讯财经":"新浪财经",rows:parseIndexRows(await response.json(),source)};}catch(error){console.warn(`${source} 上证指数行情不可用`,error);}
  }
  throw new Error("上证指数行情暂不可用");
}
