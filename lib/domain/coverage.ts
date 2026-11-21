import {inPeriod,money,parseDate,text,yes,type Dataset,type Period,derive} from './analytics.ts';
type Analysis=ReturnType<typeof derive>;
/** Physical evidence is checked over all versions; cohorts use the selected KPI periods. */
export function documentCoverage(data:Dataset,a:Analysis,period:Period){
 const cases=data.cases??[],quotes=data.quotes??[],invoices=data.invoices??[],docs=data.documents??[];
 const used=new Set([...quotes,...invoices,...cases.map(c=>({sourceId:c.signedSourceId}))].map(r=>r.sourceId));
 const byId=new Map(cases.map(c=>[text(c.id),c]));
 const root=(id:string)=>{const seen=new Set<string>();while(byId.get(id)?.parentId&&!seen.has(id)){seen.add(id);id=text(byId.get(id)!.parentId);}return id;};
 // Index once: every per-case lookup below used to rescan the whole list (quadratic in the number of cases).
 const push=<T,>(m:Map<string,T[]>,k:string,v:T)=>{const g=m.get(k);if(g)g.push(v);else m.set(k,[v]);};
 const membersByRoot=new Map<string,typeof cases>();for(const c of cases)push(membersByRoot,root(text(c.id)),c);
 const scopedByRoot=new Map<string,typeof a.cases>();for(const c of a.cases)push(scopedByRoot,root(text(c.id)),c);
 const quotesByCase=new Map<string,typeof quotes>();for(const q of quotes)push(quotesByCase,text(q.caseId),q);
 const invoicesByCase=new Map<string,typeof invoices>();for(const i of invoices)push(invoicesByCase,text(i.caseId),i);
 /* first wins, like find() */const docById=new Map<string,(typeof docs)[number]>();for(const d of docs)if(!docById.has(text(d.id)))docById.set(text(d.id),d);const clientName=new Map<string,string>();for(const cl of data.clients??[])if(!clientName.has(text(cl.id)))clientName.set(text(cl.id),text(cl.name));
 const order=new Map<object,number>();quotes.forEach((q,i)=>order.set(q,i));invoices.forEach((v,i)=>order.set(v,i));const bySource=(x:object,y:object)=>order.get(x)!-order.get(y)!;
 const quoteDocsByNumber=new Map<string,typeof docs>();for(const d of docs)if(d.kind==='報價單')push(quoteDocsByNumber,text(d.caseNumber),d);
 const scopedRoots=new Set(a.cases.map(c=>root(text(c.id))));
 const wonRoots=new Set(a.won.filter(c=>!c.parentId).map(c=>text(c.id)));
 const quoteUnits=a.latestQuotes.filter(q=>inPeriod(q.date,period));
 const quoteRoots=new Set(quoteUnits.flatMap(q=>q.caseIds.map(root)));
 const invoiceRoots=new Set(a.invoices.map(i=>root(text(i.caseId))));
 const rows=[...scopedRoots].filter(id=>!period.start&&!period.end||wonRoots.has(id)||quoteRoots.has(id)||invoiceRoots.has(id)).map(id=>{
  const scoped=scopedByRoot.get(id)??[];const c=byId.get(id)??scoped[0]!;
  const members=membersByRoot.get(id)??[];
  const qs=members.flatMap(m=>quotesByCase.get(text(m.id))??[]).sort(bySource),allInv=members.flatMap(m=>invoicesByCase.get(text(m.id))??[]).sort(bySource),inv=allInv.filter(i=>i.status==='有效');
  const voidInvoiceCount=allInv.filter(i=>i.status==='作廢').length;
  const candidateFiles=(quoteDocsByNumber.get(text(c.number))??[]).filter(d=>d.caseNumber===c.number&&!used.has(d.id)&&!['已處理','不適用'].includes(text(d.reviewStatus)));
  const source=(key:unknown)=>key==null?undefined:docById.get(text(key));
  const validUrl=(url:unknown)=>{try{return new URL(text(url)).protocol==='https:';}catch{return false;}};
  const reasons:string[]=[];const missingQuote=qs.length===0;
  if(missingQuote)reasons.push('缺報價資料');
  if(missingQuote&&candidateFiles.length)reasons.push('有同案號原件尚未配對，請核對');
  if(qs.some(q=>!validUrl(source(q.sourceId)?.url)))reasons.push('報價原檔缺連結');
  if(qs.some(q=>!parseDate(q.date)||money(q.net)===null))reasons.push('報價日期或未稅金額待補');
  if(inv.some(i=>!validUrl(source(i.sourceId)?.url)))reasons.push('發票原檔缺連結');
  if(inv.some(i=>!parseDate(i.date)||money(i.net)===null))reasons.push('發票日期或未稅金額待補');
  if(!inv.length)reasons.push(voidInvoiceCount?'僅有作廢發票，尚無有效發票':'尚無發票，不代表失單或欠款');
  if(members.some(c=>!yes(c.confirmed)))reasons.push('案件關聯待核對');
  if(wonRoots.has(id)&&!quoteRoots.has(id)&&qs.length)reasons.push('報價在其他期間或未列最新報價KPI');
  const won=wonRoots.has(id),quoted=quoteRoots.has(id),wonEver=scoped.some(c=>c.won);
  if(quoted&&!won&&wonEver)reasons.push('已成交，成交認定日在其他期間');
  const informational=new Set(['尚無發票，不代表失單或欠款','報價在其他期間或未列最新報價KPI','已成交，成交認定日在其他期間']);
  const needsReview=reasons.some(s=>!informational.has(s));
  return{id,number:text(c.number),title:text(c.title),clientId:text(c.clientId),clientName:clientName.get(text(c.clientId))||'客戶待核對',wonEver,wonInPeriod:won,quotedInPeriod:quoted,cohort:won&&quoted?'both':won?'wonOnly':quoted?'quoteOnly':'other',missingQuote,quoteCount:qs.length,invoiceCount:inv.length,voidInvoiceCount,candidateFiles,reasons,needsReview,files:[...new Set([...qs,...allInv].map(r=>text(r.sourceId)))].map(id=>source(id)).filter((d):d is NonNullable<typeof d>=>!!d)};
 });
 const unlinkedDocuments=docs.filter(d=>['報價單','發票'].includes(text(d.kind))&&!used.has(d.id)&&!['已處理','不適用'].includes(text(d.reviewStatus)));
 const matched=rows.filter(r=>r.wonInPeriod&&r.quotedInPeriod);
 return{rows,unlinkedDocuments,summary:{matchedWins:matched.length,matchedQuotes:quoteUnits.filter(q=>q.caseIds.some(id=>wonRoots.has(root(id)))).length,wonOnly:rows.filter(r=>r.cohort==='wonOnly').length,quoteOnly:quoteUnits.filter(q=>!q.caseIds.some(id=>wonRoots.has(root(id)))).length,missingQuote:rows.filter(r=>r.missingQuote).length,needsReview:rows.filter(r=>r.needsReview).length}};
}
