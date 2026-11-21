import {money,parseDate,text,type DerivedInvoice} from './analytics.ts';

/** Used when an invoice has no 收款到期日: treated as due this many days after 開票日. */
export const DEFAULT_TERM_DAYS=30;
const COLLECTED=['是','已收','已收款','y','yes','v','✓','true'];
/** 發票「已收款」欄：是／已收／V 等都算已收，空白或其他值算未收。 */
export const isCollected=(v:unknown)=>v===true||COLLECTED.includes(text(v).trim().toLowerCase());
const addDays=(d:string,n:number)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const daysBetween=(from:string,to:string)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);
export type ReceivableState='已收款'|'未收'|'逾期'|'金額待補';
export type Receivable=DerivedInvoice&{receivable:number|null;collected:boolean;ageDays:number|null;overdueDays:number|null;due:string|null;dueAssumed:boolean;state:ReceivableState};

/**
 * Owner's rule: every valid invoice is a receivable for its full gross amount until it is marked 已收款
 * (or confirmed receipts have been allocated to it). Confirmed allocations reduce the amount.
 */
export function receivableView(invoices:DerivedInvoice[],today:string){
 const rows:Receivable[]=invoices.map(i=>{
  const gross=money(i.gross),date=parseDate(i.date),explicitDue=parseDate(i.dueDate);
  const collected=isCollected(i.collected)||(i.balance!==null&&i.balance<=0);
  const receivable=collected?0:i.balance!==null?i.balance:gross===null?null:Math.max(0,gross-(i.paid??0));
  const due=explicitDue??(date?addDays(date,DEFAULT_TERM_DAYS):null);
  // Past due is past due even when the amount is still missing; the amount column shows 待補 on its own.
  const late=!collected&&!!due&&due<today;
  const state:ReceivableState=collected?'已收款':late?'逾期':receivable===null?'金額待補':'未收';
  return {...i,receivable,collected,ageDays:date?daysBetween(date,today):null,overdueDays:late?daysBetween(due!,today):null,due,dueAssumed:!explicitDue&&!!due,state} as Receivable;
 });
 const sum=(list:Receivable[],v:(r:Receivable)=>number|null)=>list.reduce((t,r)=>t+(v(r)??0),0);
 const open=rows.filter(r=>!r.collected),overdue=rows.filter(r=>r.state==='逾期'),collected=rows.filter(r=>r.collected);
 return {rows,open,overdue,collected,totals:{
  receivable:sum(open,r=>r.receivable),openCount:open.length,unknown:open.filter(r=>r.receivable===null).length,
  overdue:sum(overdue,r=>r.receivable),overdueCount:overdue.length,overdueUnknown:overdue.filter(r=>r.receivable===null).length,
  collected:sum(collected,r=>money(r.gross)),collectedCount:collected.length,collectedUnknown:collected.filter(r=>money(r.gross)===null).length,
 }};
}
