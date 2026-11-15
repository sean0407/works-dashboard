import {parseDate,text,money,type DerivedCase,type Row} from './analytics.ts';

export type ActivityState='進行中'|'即將開始'|'已結束';
export type ActivityRow={caseId:string;number:string;title:string;clientId:string;stage:string;execution:string;start:string;end:string;days:number;state:ActivityState;daysUntil:number;soon:boolean;thisMonth:boolean;headcount:number|null;net:number|null};
type Latest={caseIds:string[];net:number|null;quotes:Row[]};
const DAY=86400000;
const diff=(from:string,to:string)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/DAY);
const PEOPLE_UNITS=['位','人','名','人次'];
const INSURANCE=/保險|保費/,NOT_SHIFT=/餐|人頭|保險|保費|住宿|車資|交通|油資|制服|便當/;

/**
 * 人力人次 for one quote, estimated from its line items.
 * The insurance line covers every person-shift, so it is the best single figure; without one, add up the
 * per-person lines that are not meals, fees or travel. Returns null when the quote has no usable lines.
 */
export function headcountOf(items:Row[]):number|null{
 const people=items.filter(i=>PEOPLE_UNITS.includes(text(i.unit).trim())&&money(i.quantity)!==null);
 const insured=people.filter(i=>INSURANCE.test(text(i.description)));
 const lines=insured.length?insured:people.filter(i=>!NOT_SHIFT.test(text(i.description)));
 return lines.length?lines.reduce((t,i)=>t+money(i.quantity)!,0):null;
}

/** Cases with an activity date, upcoming first. `soon` = starts within the next 14 days or is running now. */
export function activityView(cases:DerivedCase[],latestQuotes:Latest[],quoteItems:Row[],today:string){
 const month=today.slice(0,7);
 const rows:ActivityRow[]=cases.filter(c=>!c.lost&&parseDate(c.activityStart)).map(c=>{
  const id=text(c.id),start=parseDate(c.activityStart)!,rawEnd=parseDate(c.activityEnd),end=rawEnd&&rawEnd>=start?rawEnd:start;
  const q=latestQuotes.find(x=>x.caseIds.includes(id)),own=q?.quotes.filter(v=>text(v.caseId)===id)??[];
  const counts=own.map(v=>headcountOf(quoteItems.filter(i=>i.quoteId===v.id))).filter((n):n is number=>n!==null);
  const state:ActivityState=end<today?'已結束':start<=today?'進行中':'即將開始';const daysUntil=diff(today,start);
  return {caseId:id,number:text(c.number),title:text(c.title),clientId:text(c.clientId),stage:c.stage,execution:text(c.executionStatus),start,end,days:diff(start,end)+1,state,daysUntil,
   soon:state==='進行中'||state==='即將開始'&&daysUntil<=14,thisMonth:start.slice(0,7)<=month&&end.slice(0,7)>=month,
   headcount:counts.length?counts.reduce((t,n)=>t+n,0):null,net:q&&q.caseIds.length===1?q.net:null};
 }).sort((x,y)=>Number(x.state==='已結束')-Number(y.state==='已結束')||(x.state==='已結束'?y.start.localeCompare(x.start):x.start.localeCompare(y.start)));
 const pick=(f:(r:ActivityRow)=>boolean)=>{const list=rows.filter(f);return {count:list.length,headcount:list.reduce((t,r)=>t+(r.headcount??0),0),unknown:list.filter(r=>r.headcount===null).length};};
 // Won cases that are not closed yet but have no activity date cannot be scheduled.
 const undated=cases.filter(c=>!c.lost&&!parseDate(c.activityStart)&&(c.stage==='成交'||c.stage==='報價')).length;
 return {rows,undated,totals:{all:pick(()=>true),soon:pick(r=>r.soon),month:pick(r=>r.thisMonth),upcoming:pick(r=>r.state!=='已結束')}};
}
