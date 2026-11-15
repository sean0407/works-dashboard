import {METADATA_ACTION,loadWorkbook,type TargetConfig} from '../domain/workbook.ts';
import {text,type Dataset} from '../domain/analytics.ts';

/** Settings key in the 設定 sheet that lists the Google accounts allowed to view the dashboard. */
export const ALLOWED_EMAILS_KEY='allowed_emails';

export function allowedEmails(data:Dataset):string[]|null{
 const row=(data.settings??[]).find(r=>text(r.key).trim()===ALLOWED_EMAILS_KEY);
 if(!row)return null;
 return [...new Set(text(row.value).split(/[\s,;，；]+/).map(s=>s.trim().toLowerCase()).filter(Boolean))];
}

/** Fail closed: a missing or empty list admits nobody. */
export function checkAllowed(data:Dataset,email:string):{ok:true;list:string[]}|{ok:false;list:string[]|null;message:string}{
 const list=allowedEmails(data);
 if(!list||!list.length)return{ok:false,list,message:`尚未設定可登入帳號。請在 Google Sheet「設定」分頁新增一列：設定項目填 ${ALLOWED_EMAILS_KEY}，設定值填允許的 Google 帳號（多個用逗號分隔）。`};
 if(!list.includes(email.trim().toLowerCase()))return{ok:false,list,message:`帳號 ${email} 不在可登入名單中，請聯絡管理者加入。`};
 return{ok:true,list};
}

type Fetcher=typeof fetch;

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
  if(res.status===401)return{status:'reauthentication_required',message:'Google 登入已過期，請重新登入。'};
  if(res.status===403||res.status===404)return{status:'access_denied',message:'這個 Google 帳號沒有此試算表的讀取權限；請管理者把試算表以「檢視者」共用給你。'};
  if(res.status===429)return{status:'rate_limited',message:'Google Sheets 讀取次數暫時超過上限，請稍候一分鐘再重新整理。',retryAfterMs:60000};
  if(!res.ok)return{status:'upstream_error',message:`Google Sheets 回應錯誤（${res.status}），資料未更新。`};
  const body:any=await res.json();
  return{status:'success',result:{structuredContent:action===METADATA_ACTION?body:{values:body.values??[]}}};
 };
}

export async function loadForAccount(token:string,email:string,config:TargetConfig,fetcher:Fetcher=fetch):Promise<any>{
 const result=await loadWorkbook(sheetsInvoker(token,fetcher),config);
 if(result.status!=='success')return result;
 const access=checkAllowed(result.data,email);
 // Do not hand data to the UI for an account outside the list.
 if(!access.ok)return{status:'access_denied',message:access.message,allowedEmails:null};
 return{...result,allowedEmails:access.list};
}
