import {money,parseDate,text,type DerivedCase,type Row} from './analytics.ts';
import {acFeeOf} from './margin.ts';

export const DORMANT_DAYS=180;
export type ClientRow={clientId:string;name:string;total:number;unknown:number;byYear:Record<string,number>;yearUnknown:Record<string,number>;cases:number;average:number|null;acFee:number|null;acCases:number;originals:number;won:number;winRate:number|null;lastDate:string|null;daysSince:number|null;dormant:boolean;activeThisYear:boolean;share:number;years:string[]};
type Latest={caseIds:string[];quotes:Row[]};
const diff=(from:string,to:string)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000);

/**
 * One row per paying company, across all years (not limited by the dashboard period).
 * Revenue = valid invoice net by 開票日. A case and its additions count as one case.
 */
export function clientView(clients:Row[],cases:DerivedCase[],invoices:Row[],latestQuotes:Latest[],today:string){
 const names=new Map(clients.map(c=>[text(c.id),text(c.name)]));const byCase=new Map(cases.map(c=>[text(c.id),c]));
 const caseAc=new Map<string,number|null>();for(const q of latestQuotes)if(q.caseIds.length===1)caseAc.set(q.caseIds[0],acFeeOf(q.quotes));
 const map=new Map<string,ClientRow&{projects:Set<string>}>();
 const row=(id:string)=>{let r=map.get(id);if(!r){r={clientId:id,name:names.get(id)||'客戶未確認',total:0,unknown:0,byYear:{},yearUnknown:{},cases:0,average:null,acFee:null,acCases:0,originals:0,won:0,winRate:null,lastDate:null,daysSince:null,dormant:false,activeThisYear:false,share:0,years:[],projects:new Set()};map.set(id,r);}return r;};
 for(const i of invoices){
  const c=byCase.get(text(i.caseId)),id=text(i.clientId||c?.clientId),net=money(i.net),date=parseDate(i.date);if(!id)continue;
  const r=row(id);r.total+=net??0;if(net===null)r.unknown++;if(date){const y=date.slice(0,4);r.byYear[y]=(r.byYear[y]??0)+(net??0);if(!r.years.includes(y))r.years.push(y);if(net===null)r.yearUnknown[y]=(r.yearUnknown[y]??0)+1;if(!r.lastDate||date>r.lastDate)r.lastDate=date;}
  if(c)r.projects.add(text(c.parentId||c.id));
 }
 for(const c of cases){
  const id=text(c.clientId);if(!id)continue;const r=row(id);
  // Won = the overview's evidence (signed or historical invoice) or a valid invoice. A sheet that only says 已成交, or
  // only 已結案, is not enough.
  const won=c.won||c.invoicedGross!=null;
  if(!c.parentId){r.originals++;if(won)r.won++;}
  const ac=caseAc.get(text(c.id));if(ac!=null&&won){r.acFee=(r.acFee??0)+ac;r.acCases++;}
 }
 const grand=[...map.values()].reduce((t,r)=>t+r.total,0);const year=today.slice(0,4);
 const rows:ClientRow[]=[...map.values()].map(({projects,...r})=>({...r,cases:projects.size,average:projects.size&&!r.unknown?r.total/projects.size:null,winRate:r.originals?r.won/r.originals:null,
  daysSince:r.lastDate?diff(r.lastDate,today):null,dormant:!!r.lastDate&&diff(r.lastDate,today)>DORMANT_DAYS,activeThisYear:r.years.includes(year),share:grand?r.total/grand:0})).sort((x,y)=>y.total-x.total);
 const years=[...new Set(rows.flatMap(r=>Object.keys(r.byYear)))].sort().slice(-3);
 const top3=rows.slice(0,3);
 return {rows,years,totals:{count:rows.length,total:grand,unknown:rows.reduce((t,r)=>t+r.unknown,0),active:rows.filter(r=>r.activeThisYear).length,dormant:rows.filter(r=>r.dormant).length,top3Share:top3.reduce((t,r)=>t+r.share,0),top3Ids:new Set(top3.map(r=>r.clientId))}};
}
