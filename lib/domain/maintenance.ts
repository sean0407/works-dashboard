import {text,type Dataset,type Row} from './analytics.ts';

/** Six maintained tables -> canonical analytics model. No network or legacy reads. */
export function normalizeMaintenance(input:Dataset):Dataset{
 const invoices=(input.invoices??[]).filter(i=>i.status!=='待開票');
 // A voided invoice no longer fulfils its plan; the reissued row (or a 待開票 row) carries the milestone.
 const invoiceSchedule=(input.invoices??[]).filter(i=>i.status!=='作廢'&&(text(i.scheduleId)||i.status==='待開票')).map(i=>({
  id:text(i.scheduleId)||text(i.id),caseId:i.caseId,label:i.type,expectedGross:i.expectedGross??null,
  dueDate:i.plannedDate??null,invoiceId:i.status==='有效'?i.id:null,confirmed:i.scheduleConfirmed??false,notes:i.notes??null,
 }));
 const receipts:Row[]=[],allocations:Row[]=[];const bankIds=new Set<string>();const allocationIds=new Set<string>();
 for(const r of input.receipts??[]){
  const kind=text(r.recordType)||'收款';if(!['收款','分配'].includes(kind))throw Error(`收款紀錄類型無效：${kind}`);
  if(kind==='分配'&&[r.date,r.clientId,r.amount,r.reference,r.verified,r.sourceId].some(v=>v!==null&&v!==undefined&&v!==''))throw Error(`分配列 ${text(r.id)} 請勿重填銀行入帳欄位；原始收款僅記一次。`);
  if(kind==='收款'){
   if(bankIds.has(text(r.id)))throw Error(`收款ID ${text(r.id)} 重複；銀行入帳只能記一次，分配另用分配列。`);bankIds.add(text(r.id));
   receipts.push(Object.fromEntries(['id','date','clientId','amount','reference','verified','sourceId','notes'].map(k=>[k,r[k]??null])));
  }
  const reference=text(r.invoiceId);const hasAllocation=kind==='分配'||reference||r.allocatedAmount!==null&&r.allocatedAmount!==undefined;
  if(hasAllocation){
   const matches=invoices.filter(i=>i.id===reference||i.number===reference);const ids=new Set(matches.map(i=>text(i.id)));
   const invoice=ids.size===1?matches[0]:null;
   const key=text(r.allocationId)||`${text(r.id)}::${reference}`;
   if(allocationIds.has(key))throw Error(`分配ID ${key} 重複，請合併同筆分配或給不同編號。`);allocationIds.add(key);
   if(ids.size>1)throw Error(`發票對應 ${reference} 不唯一，請先修正發票識別碼。`);
   allocations.push({id:key,receiptId:r.id,invoiceId:invoice?.id??reference,caseId:r.caseId??invoice?.caseId??null,amount:r.allocatedAmount??null,notes:r.allocationNotes??null});
  }
 }
 const reconciliation:Row[]=[];
 const warningOwners:Row[]=[...(input.cases??[]).map(c=>({...c,warningCaseId:c.id,warningSourceId:null})),...(input.documents??[]).map(d=>({...d,warningCaseId:null,warningSourceId:d.id}))];
 for(const c of warningOwners){
  if(['已處理','不適用'].includes(text(c.reviewStatus)))continue;
  text(c.reviewNotes).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).forEach((line,index)=>{
   const parsed=/^(?:【([^】]+)】)?(.*?)(?:（來源文件：([^）]+)）)?$/.exec(line)!;
   reconciliation.push({id:`review:${text(c.id)}:${index+1}`,caseId:c.warningCaseId,sourceId:parsed[3]??c.warningSourceId,type:parsed[1]??'待核對',description:parsed[2],status:'待核對',resolution:null});
  });
 }
 return {...input,invoices,receipts,invoiceSchedule,allocations,reconciliation,quoteItems:input.quoteItems??[],tasks:[]};
}
