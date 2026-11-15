import type {CaseStage,DerivedCase} from './analytics.ts';

export type StageSummary={stage:CaseStage;count:number;share:number;amount:number|null;unknown:number};
type QuoteGroup={caseIds:string[];net:number|null};

/** Stages whose amount comes from invoices; earlier stages use the latest quote. */
const INVOICED:CaseStage[]=['成交','開票','結案'];

/**
 * Count original cases per stage (additions roll into their parent case) with their share,
 * and the known amount before tax: latest quote for 報價, invoices from 成交 on.
 */
export function stageSummary(cases:DerivedCase[],latestQuotes:QuoteGroup[],stages:CaseStage[]):StageSummary[]{
 const byId=new Map(cases.map(c=>[String(c.id),c]));
 const quoteNet=new Map<string,number|null>();
 for(const q of latestQuotes)for(const id of q.caseIds)quoteNet.set(id,q.caseIds.length===1?q.net:null);
 const rootOf=(c:DerivedCase)=>(c.parentId&&byId.get(String(c.parentId)))||c;
 const roots=cases.filter(c=>!c.parentId);
 return stages.map(stage=>{
  const members=cases.filter(c=>rootOf(c).stage===stage);
  const count=roots.filter(c=>c.stage===stage).length;
  let amount=0,unknown=0,any=false;
  if(stage!=='提案'&&stage!=='未成交')for(const c of members){
   const id=String(c.id);
   const v=INVOICED.includes(stage)?(c.saleNet??(quoteNet.has(id)?quoteNet.get(id)!:null)):(quoteNet.has(id)?quoteNet.get(id)!:null);
   if(v==null){if(!c.parentId)unknown++;}else{amount+=v;any=true;}
  }
  return {stage,count,share:roots.length?count/roots.length*100:0,amount:any?amount:null,unknown};
 });
}
