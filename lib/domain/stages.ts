import type {CaseStage,DerivedCase} from './analytics.ts';

export type StageSummary={stage:CaseStage;count:number;share:number;amount:number|null;unknown:number};
type QuoteGroup={caseIds:string[];net:number|null};

/** Stages whose amount comes from invoices once there are any; earlier stages use the latest quote. */
const INVOICED:CaseStage[]=['成交','開票','結案'];

/**
 * Count original cases per stage (additions roll into their parent case) with their share,
 * and the known amount before tax: latest quote for 報價, invoices from 成交 on.
 */
export function stageSummary(cases:DerivedCase[],latestQuotes:QuoteGroup[],stages:CaseStage[]):StageSummary[]{
 const byId=new Map(cases.map(c=>[String(c.id),c]));
 const quoteNet=new Map<string,number|null>();
 for(const q of latestQuotes)for(const id of q.caseIds)quoteNet.set(id,q.caseIds.length===1?q.net:null);
 // A 原案ID that points to no case is treated as its own root, so its amount and its count agree.
 const parentOf=(c:DerivedCase)=>c.parentId?byId.get(String(c.parentId)):undefined;
 const rootOf=(c:DerivedCase)=>parentOf(c)||c;
 const roots=cases.filter(c=>!parentOf(c));
 return stages.map(stage=>{
  const members=cases.filter(c=>rootOf(c).stage===stage);
  const count=roots.filter(c=>c.stage===stage).length;
  let amount=0,any=false;const unknownRoots=new Set<string>();
  if(stage!=='提案'&&stage!=='未成交')for(const c of members){
   const id=String(c.id);
   const quote=quoteNet.has(id)?quoteNet.get(id)!:null;
   // 開票／結案 use the valid-invoice net (signed or not); a missing invoice net stays unknown instead of borrowing
   // the quote. A case with no invoice yet (成交, or 結案 marked by hand) falls back to its latest quote.
   const billed=c.invoicedGross!=null,addition=!!parentOf(c);
   // In 開票／結案 an addition adds only what it has invoiced: an unbilled addition's quote is not billing.
   if(stage!=='成交'&&INVOICED.includes(stage)&&addition&&!billed)continue;
   const v=INVOICED.includes(stage)?(billed?c.invoicedNet??null:quote):quote;
   if(v==null)unknownRoots.add(String(rootOf(c).id));else{amount+=v;any=true;}
  }
  return {stage,count,share:roots.length?count/roots.length*100:0,amount:any?amount:null,unknown:unknownRoots.size};
 });
}
