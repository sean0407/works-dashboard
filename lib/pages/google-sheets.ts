import {METADATA_ACTION,loadWorkbook,type TargetConfig} from '../domain/workbook.ts';
import {text} from '../domain/analytics.ts';

type Fetcher=typeof fetch;

/** Tell apart the Google failures that look alike to the visitor but need different fixes. */
export function googleError(status:number,body:any){
 const err=body?.error??{};
 const reasons=[err.status,...(err.details??[]).map((d:any)=>d?.reason),...(err.errors??[]).map((e:any)=>e?.reason)].filter(Boolean).map(String);
 const raw=text(err.message);
 const has=(...keys:string[])=>keys.some(k=>reasons.includes(k)||raw.includes(k));
 const detail=raw?`（Google：${raw}）`:'';
 if(status===401)return{status:'reauthentication_required',message:'Google 登入已過期，請登出後重新登入。'};
 if(status===429)return{status:'rate_limited',message:'Google Sheets 讀取次數暫時超過上限，請稍候一分鐘再重新整理。',retryAfterMs:60000};
 if(has('SERVICE_DISABLED','accessNotConfigured','has not been used','is disabled'))return{status:'configuration_required',message:`網站的 Google Cloud 專案尚未啟用 Google Sheets API；請到 Google Cloud Console 啟用後等幾分鐘再試。${detail}`};
 if(has('ACCESS_TOKEN_SCOPE_INSUFFICIENT','insufficientPermissions','insufficient authentication scopes'))return{status:'reauthentication_required',message:'登入時沒有允許「查看 Google 試算表」；請登出，重新登入並勾選該權限。'};
 if(has('not supported for this document','FAILED_PRECONDITION'))return{status:'source_error',message:`來源檔案不是 Google 試算表格式（可能是上傳的 Excel 檔）；請在 Google 雲端硬碟用「檔案 → 儲存為 Google 試算表」轉換後更新網站設定。${detail}`};
 if(status===404)return{status:'access_denied',message:`找不到這份試算表；可能尚未共用給這個帳號，或檔案已被移動、刪除。${detail}`};
 if(status===403)return{status:'access_denied',message:`這個 Google 帳號沒有此試算表的讀取權限；請試算表擁有者以「檢視者」共用給目前登入的帳號。${detail}`};
 return{status:'upstream_error',message:`Google Sheets 回應錯誤（${status}），資料未更新。${detail}`};
}

/** Adapts the connector-style calls used by loadWorkbook to the Google Sheets REST API with the visitor's own token. */
export function sheetsInvoker(token:string,fetcher:Fetcher=fetch){
 return async(_connector:string,action:string,args:any)=>{
  const base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(args.spreadsheet_id)}`;
  const url=action===METADATA_ACTION
   ?`${base}?fields=${encodeURIComponent('sheets.properties(title,gridProperties)')}`
   :`${base}/values/${encodeURIComponent(`'${String(args.sheet_name).replace(/'/g,"''")}'!${args.range}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
  let res:Response;
  try{res=await fetcher(url,{headers:{Authorization:`Bearer ${token}`}});}
  catch{return{status:'network_error',message:'目前無法連線至 Google Sheets，請稍後重新整理。'};}
  if(!res.ok)return googleError(res.status,await res.json().catch(()=>null));
  const body:any=await res.json();
  return{status:'success',result:{structuredContent:action===METADATA_ACTION?body:{values:body.values??[]}}};
 };
}

/** Access is decided by Google: an account the sheet is not shared with gets a 403/404 and no data. */
export async function loadForAccount(token:string,config:TargetConfig,fetcher:Fetcher=fetch):Promise<any>{
 return loadWorkbook(sheetsInvoker(token,fetcher),config);
}
