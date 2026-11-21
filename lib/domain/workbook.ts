import schema from './schema.json' with {type:'json'};
import {money,parseDate,text,yes,type Dataset,type Row} from './analytics.ts';
import {normalizeMaintenance} from './maintenance.ts';
export const CONNECTOR_ID='connector_5f3c8c41a1e54ad7a76272c89e2554fa';
export const READ_ACTION='get_spreadsheet_range';
export const METADATA_ACTION='get_spreadsheet_metadata';
const definitions: Record<string,{sheet:string;columns:Record<string,string>}> = schema.collections;
const statusFields:Record<string,string[]>={cases:['mode','status','executionStatus','closureStatus','reviewStatus'],invoices:['status'],receipts:['recordType'],documents:['kind','reviewStatus']};
export type TargetConfig={spreadsheetId?:string;spreadsheetUrl?:string;driveFolderUrl?:string};
export function parseSheet(collection:string,values:unknown[][]):Row[]{
 const def=definitions[collection];if(!def)throw Error('未允許的工作表。');
 const keys=Object.keys(def.columns),headers=Object.values(def.columns);
 if(!values[0]||headers.some((h,index)=>text(values[0][index]).trim()!==h))throw Error(`「${def.sheet}」欄位與資料契約不同；請保留第 1 列欄名及順序。`);
 return values.slice(1).map((r,index)=>({r,row:index+2})).filter(({r})=>r.some(v=>v!==null&&v!==undefined&&v!=='')).map(({r,row})=>{
  if(!r[0])throw Error(`「${def.sheet}」第 ${row} 列缺少識別碼，請先補齊。`);
  return Object.fromEntries(keys.map((key,i)=>{
   const value=r[i];if(value===''||value==null)return[key,null];
   if(schema.dates.includes(key)){const d=parseDate(value);if(!d)throw Error(`「${def.sheet}」日期無法辨識（第 ${row} 列／${def.columns[key]}）。`);return[key,d];}
   if(schema.booleans.includes(key)){if(!['是','否',true,false].includes(value as any))throw Error(`「${def.sheet}」${def.columns[key]} 須為是或否。`);return[key,yes(value)];}
   if(schema.numbers.includes(key)){const signed=collection==='quoteItems'&&['amount','quantity'].includes(key);const n=money(value,signed);if(n===null)throw Error(`「${def.sheet}」${def.columns[key]} 須為有效的${signed?'':'非負'}數字。`);return[key,n];}
   // Status-like cells are compared exactly downstream; stray spaces must not silently drop a record.
   if(statusFields[collection]?.includes(key)){const t=text(value).trim();return[key,t||null];}
   return[key,text(value)];
  }));
 });
}
const payloads=(result:any)=>[result?.structuredContent,...(result?.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>{try{return JSON.parse(c.text);}catch{return null;}})];
export function extractValues(result:any):unknown[][]{
 for(const c of payloads(result)){
  for(const value of [c?.values,c?.data?.values,c?.result?.values])if(Array.isArray(value)&&value.every(Array.isArray))return value;
 }
 throw Error('Google Sheets 回傳格式無法辨識，資料未更新。');
}
export function checkRequest(req:{method:string;origin:string|null;url:string;userId:string|null;body:unknown}):string|null{
 if(req.method!=='POST')return '僅接受明確的重新讀取請求。';
 if(!req.userId)return '請先登入此私人網站。';
 if(!req.origin||req.origin!==new URL(req.url).origin)return '不接受跨網站請求。';
 if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)return '讀取目標由伺服器指定，不能變更。';
 return null;
}
/** A sheet the dashboard can work without: 報價明細備份 only feeds the activity headcount estimate. */
const OPTIONAL_SHEETS=new Set(['quoteItems']);
const columnName=(n:number)=>{let result='';while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;};
export async function loadWorkbook(invoke:(id:string,action:string,args:any)=>Promise<any>,config:TargetConfig,options:{pageSize?:number}={}):Promise<any>{
 if(!config.spreadsheetId||! /^[A-Za-z0-9_-]{8,200}$/.test(config.spreadsheetId))return{status:'configuration_required',message:'資料來源尚未完成設定；完成 Google Sheets 連結後即可讀取。'};
 const pageSize=Math.max(2,Math.min(options.pageSize??250,500));const maxRows=10000;
 const data:Dataset={};let failure:any=null;
 let entries=schema.sourceCollections.map(key=>[key,definitions[key]] as const);
 let sheetBounds:Map<string,number>;
 try{
  const result=await invoke(CONNECTOR_ID,METADATA_ACTION,{spreadsheet_id:config.spreadsheetId});
  if(result?.status!=='success')return result?.status?result:{status:'upstream_error',message:'來源未確認讀取成功。'};
  const metadata=payloads(result.result).find(p=>Array.isArray(p?.sheets));
  if(!metadata)throw Error('Google Sheets 工作表結構無法辨識。');
  sheetBounds=new Map();
  for(const [key,def] of entries){
   const properties=metadata.sheets.find((s:any)=>s.properties?.title===def.sheet)?.properties;
   const grid=properties?.gridProperties;
   if(!properties&&OPTIONAL_SHEETS.has(key)){data[key]=[];continue;}
   if(!grid||!Number.isInteger(grid.rowCount)||grid.rowCount<1||grid.columnCount<Object.keys(def.columns).length)throw Error(`「${def.sheet}」工作表不存在或欄數不足，請確認來源結構。`);
   if(grid.rowCount>maxRows)throw Error(`「${def.sheet}」工作表超過 10,000 列上限，請先分期封存；本次未顯示不完整總額。`);
   sheetBounds.set(def.sheet,grid.rowCount);
  }
  entries=entries.filter(([,def])=>sheetBounds.has(def.sheet));
 }catch(error){return{status:'source_error',message:error instanceof Error?error.message:'工作表結構無法驗證。'};}
 // Three bounded reads in flight; no cross-request or cross-visitor cache.
 let next=0;
 async function work(){while(next<entries.length&&!failure){const [key,def]=entries[next++];const values:unknown[][]=[];
  try{
   // Bound the read by the ID and the next column: a last row whose ID was left blank must reach parseSheet (and fail
   // loudly there, like any other row missing its ID) instead of silently falling off the end.
   const idResult=await invoke(CONNECTOR_ID,READ_ACTION,{spreadsheet_id:config.spreadsheetId,sheet_name:def.sheet,range:`A1:B${sheetBounds.get(def.sheet)}`,value_render_option:'UNFORMATTED_VALUE'});
   if(idResult?.status!=='success'){failure=idResult?.status?idResult:{status:'upstream_error',message:'來源識別碼未確認讀取成功。'};return;}
   const ids=extractValues(idResult.result);let lastRow=1;
   const filled=(v:unknown)=>v!==''&&v!=null;
   ids.forEach((row,index)=>{if(filled(row[0])||filled(row[1]))lastRow=index+1;});
   for(let start=1;start<=lastRow;start+=pageSize){
   const end=Math.min(start+pageSize-1,lastRow);const result=await invoke(CONNECTOR_ID,READ_ACTION,{spreadsheet_id:config.spreadsheetId,sheet_name:def.sheet,range:`A${start}:${columnName(Object.keys(def.columns).length)}${end}`,value_render_option:'UNFORMATTED_VALUE'});
   if(result?.status!=='success'){failure=result?.status?result:{status:'upstream_error',message:'來源未確認讀取成功。'};return;}
   const page=extractValues(result.result);values.push(...page);
   // Preserve physical row positions across completely empty intermediate pages.
   while(values.length<end)values.push([]);
  }
  data[key]=parseSheet(key,values);
  }catch(error){failure={status:'source_error',message:error instanceof Error?error.message:'資料來源無法驗證。',source:def.sheet};}
 }}
 await Promise.all([work(),work(),work()]);if(failure)return failure;
 const version=data.settings?.find(r=>r.key==='schema_version');
 if(version&&Number(version.value)!==schema.version)return{status:'source_error',message:'工作簿資料版本不符，請確認欄位設定。'};
 try{return{status:'success',data:normalizeMaintenance(data),loadedAt:new Date().toISOString(),links:{spreadsheet:config.spreadsheetUrl??`https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`,folder:config.driveFolderUrl??null}};}
 catch(error){return{status:'source_error',message:error instanceof Error?error.message:'六分頁資料無法整合，本次未更新。'};}
}
