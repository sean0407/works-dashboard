import {inPeriod,money,parseDate,text,yes,type Dataset,type Period,derive} from './analytics.ts';
type Analysis=ReturnType<typeof derive>;
/** Physical evidence is checked over all versions; cohorts use the selected KPI periods. */
export function documentCoverage(data:Dataset,a:Analysis,period:Period){
 const cases=data.cases??[],quotes=data.quotes??[],invoices=data.invoices??[],docs=data.documents??[];
 const used=new Set([...quotes,...invoices,...cases.map(c=>({sourceId:c.signedSourceId}))].map(r=>r.sourceId));
 const byId=new Map(cases.map(c=>[text(c.id),c]));
 const root=(id:string)=>{const seen=new Set<string>();while(byId.get(id)?.parentId&&!seen.has(id)){seen.add(id);id=text(byId.get(id)!.parentId);}return id;};
 const scopedRoots=new Set(a.cases.map(c=>root(text(c.id))));
 const wonRoots=new Set(a.won.filter(c=>!c.parentId).map(c=>text(c.id)));
 const quoteUnits=a.latestQuotes.filter(q=>inPeriod(q.date,period));
 const quoteRoots=new Set(quoteUnits.flatMap(q=>q.caseIds.map(root)));
 const invoiceRoots=new Set(a.invoices.map(i=>root(text(i.caseId))));
 const rows=[...scopedRoots].filter(id=>!period.start&&!period.end||wonRoots.has(id)||quoteRoots.has(id)||invoiceRoots.has(id)).map(id=>{
  const c=byId.get(id)??a.cases.find(c=>root(text(c.id))===id)!;
  const members=cases.filter(c=>root(text(c.id))===id),ids=new Set(members.map(c=>c.id));
  const qs=quotes.filter(q=>ids.has(q.caseId)),allInv=invoices.filter(i=>ids.has(i.caseId)),inv=allInv.filter(i=>i.status==='有效');
  const voidInvoiceCount=allInv.filter(i=>i.status==='作廢').length;
  const candidateFiles=docs.filter(d=>d.kind==='報價單'&&d.caseNumber===c.number&&!used.has(d.id)&&!['已處理','不適用'].includes(text(d.reviewStatus)));
  const source=(key:unknown)=>docs.find(d=>d.id===key);
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
  const won=wonRoots.has(id),quoted=quoteRoots.has(id),wonEver=a.cases.some(c=>root(text(c.id))===id&&c.won);
  if(quoted&&!won&&wonEver)reasons.push('已成交，成交認定日在其他期間');
  const informational=new Set(['尚無發票，不代表失單或欠款','報價在其他期間或未列最新報價KPI','已成交，成交認定日在其他期間']);
  const needsReview=reasons.some(s=>!informational.has(s));
  return{id,number:text(c.number),title:text(c.title),clientId:text(c.clientId),clientName:text(data.clients?.find(cl=>cl.id===c.clientId)?.name)||'客戶待核對',wonEver,wonInPeriod:won,quotedInPeriod:quoted,cohort:won&&quoted?'both':won?'wonOnly':quoted?'quoteOnly':'other',missingQuote,quoteCount:qs.length,invoiceCount:inv.length,voidInvoiceCount,candidateFiles,reasons,needsReview,files:[...new Set([...qs,...allInv].map(r=>text(r.sourceId)))].map(id=>source(id)).filter((d):d is NonNullable<typeof d>=>!!d)};
 });
 const unlinkedDocuments=docs.filter(d=>['報價單','發票'].includes(text(d.kind))&&!used.has(d.id)&&!['已處理','不適用'].includes(text(d.reviewStatus)));
 const matched=rows.filter(r=>r.wonInPeriod&&r.quotedInPeriod);
 return{rows,unlinkedDocuments,summary:{matchedWins:matched.length,matchedQuotes:quoteUnits.filter(q=>q.caseIds.some(id=>wonRoots.has(root(id)))).length,wonOnly:rows.filter(r=>r.cohort==='wonOnly').length,quoteOnly:quoteUnits.filter(q=>!q.caseIds.some(id=>wonRoots.has(root(id)))).length,missingQuote:rows.filter(r=>r.missingQuote).length,needsReview:rows.filter(r=>r.needsReview).length}};
}
