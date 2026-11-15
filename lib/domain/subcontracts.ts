import {inPeriod,money,text,type Dataset,type DerivedCase,type Period,type Row} from './analytics.ts';

/** Only 有效 rows are costs; 參考 (a quote superseded by the vendor's invoice), 重複 and 作廢 are kept for reference. */
export const COUNTED_STATUS='有效';

export type CaseCost={caseId:string;number:string;title:string;revenueNet:number|null;costNet:number;costUnknown:number;margin:number|null;marginRate:number|null;vendors:string[]};

export function subcontractView(data:Dataset,cases:DerivedCase[],period:Period){
 const caseIds=new Set(cases.map(c=>text(c.id)));
 const all=(data.subcontracts??[]).filter(r=>inPeriod(r.date,period)&&(!r.caseId||caseIds.has(text(r.caseId))));
 const counted=all.filter(r=>(text(r.status)||COUNTED_STATUS)===COUNTED_STATUS);
 const byCase=new Map<string,Row[]>();
 for(const r of counted){const k=text(r.caseId);if(!k)continue;byCase.set(k,[...(byCase.get(k)??[]),r]);}
 const perCase:CaseCost[]=[...byCase].map(([caseId,rows])=>{
  const c=cases.find(x=>text(x.id)===caseId);
  const nets=rows.map(r=>money(r.net));
  const costNet=nets.reduce<number>((s,v)=>s+(v??0),0);const costUnknown=nets.filter(v=>v===null).length;
  const revenueNet=c?.saleNet??null;
  const margin=revenueNet!==null&&!costUnknown?revenueNet-costNet:null;
  return {caseId,number:text(c?.number)||text(rows[0].caseNumber),title:text(c?.title),revenueNet,costNet,costUnknown,margin,marginRate:margin!==null&&revenueNet?margin/revenueNet*100:null,vendors:[...new Set(rows.map(r=>text(r.vendor)).filter(Boolean))]};
 }).sort((a,b)=>b.costNet-a.costNet);
 const nets=counted.map(r=>money(r.net));
 return {
  rows:all,
  perCase,
  totals:{costNet:nets.reduce<number>((s,v)=>s+(v??0),0),unknown:nets.filter(v=>v===null).length,count:counted.length,vendors:new Set(counted.map(r=>text(r.vendor)).filter(Boolean)).size,cases:byCase.size,unlinked:counted.filter(r=>!r.caseId).length},
 };
}
