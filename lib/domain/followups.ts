import {parseDate,text,type DerivedCase,type Row} from './analytics.ts';
import {acFeeOf} from './margin.ts';

export type FollowBucket='fresh'|'mid'|'stale'|'undated'|'noquote';
export type FollowRow={caseId:string;number:string;title:string;clientId:string;stage:string;addition:boolean;hasQuote:boolean;quoteDate:string|null;days:number|null;net:number|null;acFee:number|null;next:string|null;nextAction:string;lastContact:string|null;due:boolean;bucket:FollowBucket};
type Latest={caseIds:string[];date:string|null;net:number|null;quotes:Row[]};
const daysBetween=(from:string,to:string)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);

/**
 * Cases still waiting for the client's decision (提案／報價 stage), with how long the latest quote has been out.
 * 「該追」= 下次追案日 has arrived. Without that date, the quote's age is the only signal.
 */
export function followupView(cases:DerivedCase[],latestQuotes:Latest[],today:string){
 const rows:FollowRow[]=cases.filter(c=>c.stage==='提案'||c.stage==='報價').map(c=>{
  const id=text(c.id),q=latestQuotes.find(x=>x.caseIds.includes(id));
  const quoteDate=q?.date??null,days=quoteDate?daysBetween(quoteDate,today):null,next=parseDate(c.nextFollowupDate);
  const single=!!q&&q.caseIds.length===1;
  return {caseId:id,number:text(c.number),title:text(c.title),clientId:text(c.clientId),stage:c.stage,addition:!!c.parentId,hasQuote:!!q,quoteDate,days,
   net:single?q!.net:null,acFee:single?acFeeOf(q!.quotes):null,next,nextAction:text(c.nextAction),lastContact:parseDate(c.lastContactDate),
   due:!!next&&next<=today,bucket:!q?'noquote':days===null?'undated':days<=30?'fresh':days<=90?'mid':'stale'} as FollowRow;
 }).sort((x,y)=>Number(y.due)-Number(x.due)||(x.due?(x.next??'').localeCompare(y.next??''):0)||(y.quoteDate??'').localeCompare(x.quoteDate??''));
 // net is the known part; unknown counts quoted cases whose amount is missing (never silently added as 0).
 const pick=(f:(r:FollowRow)=>boolean)=>{const list=rows.filter(f);return {count:list.length,net:list.reduce((t,r)=>t+(r.net??0),0),unknown:list.filter(r=>r.hasQuote&&r.net===null).length};};
 return {rows,totals:{all:pick(()=>true),due:pick(r=>r.due),fresh:pick(r=>r.bucket==='fresh'),mid:pick(r=>r.bucket==='mid'),stale:pick(r=>r.bucket==='stale'),noquote:pick(r=>r.bucket==='noquote')}};
}
