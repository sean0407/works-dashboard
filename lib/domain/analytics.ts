export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type Dataset = Record<string, Row[]>;
export type Period = { start: string | null; end: string | null };
export type Filters = { period: Period; today: string; clientId?: string; brand?: string; status?: string; search?: string; activity?: Period };
export type Issue = { type: string; caseId?: string; description: string };
export type DerivedCase = Row & { won: boolean; lost: boolean; closed: boolean; saleDate: string | null; saleNet: number | null; historical: boolean; certified: boolean; unverifiedWon: boolean; stage: CaseStage; stageFlag: string | null; invoicedGross: number | null; paymentTypes: string; derivedStatus: string };
export type DerivedInvoice = Row & {balance:number|null;paid:number|null;overdue:boolean};
const INVOICE_STATUSES=['有效','作廢'];
const CASE_STATUSES=['需求接洽','準備報價','已報價待確認','已成交','未成交','取消','待核對'];
const CASE_MODES=['歷史','新案'];
/** Operational progress shown on the case views; 未成交 is a separate terminal state. */
export const CASE_STAGES = ['提案','報價','成交','開票','結案'] as const;
const PAYMENT_ORDER=['全款','訂金','尾款','追加'];
export type CaseStage = typeof CASE_STAGES[number] | '未成交';
export const text = (v: unknown) => v == null ? '' : String(v);
export const yes = (v: unknown) => v === true || v === '是';
export const money = (v: unknown,allowNegative=false): number | null => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) && (allowNegative || n >= 0) ? n : null;
};
export function parseDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 150000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s ? s : null;
}
export const taipeiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
const iso = (y: number,m: number,d: number) => new Date(Date.UTC(y,m,d)).toISOString().slice(0,10);
const shifted = (s: string, months: number) => {
  const [y,m,d] = s.split('-').map(Number); const first = new Date(Date.UTC(y,m-1+months,1));
  const last = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
  return iso(first.getUTCFullYear(),first.getUTCMonth(),Math.min(d,last));
};
export function makePeriod(kind: string, anchor: string, today: string): Period & {previous: Period; label: string} {
  if (kind === 'all') return {start:null,end:null,previous:{start:null,end:null},label:'全部期間'};
  const [y,m] = (parseDate(anchor) ?? today).split('-').map(Number);
  const step = kind === 'year' ? 12 : kind === 'quarter' ? 3 : 1;
  const month = step === 12 ? 0 : step === 3 ? Math.floor((m-1)/3)*3 : m-1;
  const start = iso(y,month,1); const fullEnd = iso(y,month+step,0);
  const end = today >= start && today < fullEnd ? today : fullEnd;
  const previousStart = shifted(start,-step);
  // Completed periods compare the whole prior period; active periods compare the same calendar progress.
  const previousEnd = end === fullEnd ? iso(new Date(previousStart).getUTCFullYear(),new Date(previousStart).getUTCMonth()+step,0) : shifted(end,-step);
  return {start,end,previous:{start:previousStart,end:previousEnd},label:step===12?`${y} 年`:step===3?`${y} 年 Q${month/3+1}`:`${y} 年 ${m} 月`};
}
export const inPeriod = (date: unknown,p: Period) => {
  const d = parseDate(date); return !p.start && !p.end ? true : !!d && (!p.start || d>=p.start) && (!p.end || d<=p.end);
};
export const sumKnown = (values: (number|null)[]) => values.reduce<number>((s,v)=>s+(v??0),0);
const completeSum = (values: (number|null)[]) => values.some(v=>v===null) ? null : sumKnown(values);
export function compare(current: number|null, previous: number|null, covered: boolean): number|null {
  return !covered || current===null || previous===null || previous===0 ? null : (current-previous)/previous*100;
}
export function applyRefresh(previous: any, response: any): any {
  return response.status === 'success' && response.data ? {data:response.data,loadedAt:response.loadedAt,stale:false,error:null,links:response.links} : {...previous,stale:!!previous.data,error:response};
}
/** Select before filtering by period: an obsolete quote never returns as current. */
const complementaryBundle=(quotes:Row[])=>quotes.length>1&&new Set(quotes.map(q=>q.caseId)).size===1&&!!text(quotes[0].groupId)&&!!parseDate(quotes[0].date)&&new Set(quotes.map(q=>q.groupId)).size===1&&new Set(quotes.map(q=>q.version)).size===1&&new Set(quotes.map(q=>parseDate(q.date))).size===1&&quotes.every(q=>q.role==='互補'&&yes(q.effective))&&new Set(quotes.map(q=>q.id)).size===quotes.length;
export function selectLatestQuotes(quotes: Row[], issues: Issue[],caseNumbers=new Map<string,string>()) {
  const groups=new Map<string,Row[]>();
  for(const q of quotes){const id=caseNumbers.get(text(q.caseId))||`internal:${text(q.caseId)}`;const group=groups.get(id)??[];group.push(q);groups.set(id,group);}
  return [...groups].map(([number,versions])=>{
    const dated=versions.map(q=>({q,date:parseDate(q.date)}));
    const missingDate=dated.some(v=>!v.date);
    const date=missingDate?null:dated.map(v=>v.date!).sort().at(-1)!;
    let candidates=missingDate?versions:dated.filter(v=>v.date===date).map(v=>v.q);
    if(!missingDate&&candidates.length>1){
      const numbered=candidates.map(q=>({q,n:/^V\s*(\d+(?:\.\d+)?)$/i.exec(text(q.version).trim())}));
      if(numbered.every(v=>v.n)){const max=Math.max(...numbered.map(v=>Number(v.n![1])));candidates=numbered.filter(v=>Number(v.n![1])===max).map(v=>v.q);}
    }
    const bundle=!missingDate&&complementaryBundle(candidates);
    if(!missingDate&&!bundle&&candidates.length>1){
      const confirmed=candidates.filter(q=>yes(q.effective));if(confirmed.length===1)candidates=confirmed;
    }
    const selected=!missingDate&&(bundle||candidates.length===1)?candidates:[];
    const quote=selected[0]??null;
    const caseIds=[...new Set((selected.length?selected:candidates).map(q=>text(q.caseId)))];
    const caseId=quote?text(quote.caseId):caseIds.length===1?caseIds[0]:'';
    if(!quote)for(const id of caseIds)issues.push({type:'latest_quote',caseId:id,description:'最新報價無法唯一判定，請補齊報價日並確認同日版本；本案金額保留待核對，不以舊版代替。'});
    return {number,caseId,caseIds,quote,quotes:selected,date,net:quote?completeSum(selected.map(q=>money(q.net))):null};
  });
}
export function derive(data: Dataset, filters: Filters) {
  const rows = (k: string) => data[k] ?? [];
  const issues: Issue[] = [];
  const unique = (items: Row[], key: string, type: string, report=true) => {
    const found=new Set<string>();return items.filter(r=>{
      const id=text(r[key] || r.id);if(!id || found.has(id)){if(report)issues.push({type,caseId:text(r.caseId),description:`重複或缺少識別碼：${id || '空白'}，未重複加總。`});return false;}found.add(id);return true;
    });
  };
  // Invoice identity problems are reported once per row by the identity check below.
  const allInvoices = unique(rows('invoices'),'number','duplicate_invoice',false);
  for(const invoice of allInvoices)if(!INVOICE_STATUSES.includes(text(invoice.status)))issues.push({type:'invalid_value',caseId:text(invoice.caseId),description:`發票 ${text(invoice.number)||text(invoice.id)} 的發票狀態「${text(invoice.status)||'空白'}」無法辨識（應為有效或作廢），未計入開票金額。`});
  const validInvoices = allInvoices.filter(r=>r.status==='有效');
  const sourceCases = unique(rows('cases'),'id','duplicate_case');
  for(const c of sourceCases){
    if(c.status!=null&&!CASE_STATUSES.includes(text(c.status)))issues.push({type:'invalid_value',caseId:text(c.id),description:`${text(c.number)} 的商機狀態「${text(c.status)}」無法辨識，請改用下拉選項。`});
    if(c.mode!=null&&!CASE_MODES.includes(text(c.mode)))issues.push({type:'invalid_value',caseId:text(c.id),description:`${text(c.number)} 的「歷史或新案」填寫「${text(c.mode)}」無法辨識，目前視為新案。`});
  }
  for(const invoice of validInvoices)if(!sourceCases.some(c=>c.id===invoice.caseId))issues.push({type:'case_reference',description:`發票 ${text(invoice.number)} 尚未連結有效案件；保留在整體財務，請確認案件關聯。`});
  for(const q of rows('quotes'))if(!sourceCases.some(c=>c.id===q.caseId))issues.push({type:'quote_reference',description:`報價 ${text(q.id)}${q.title?`（${text(q.title)}）`:''} 的案件ID「${text(q.caseId)||'空白'}」找不到對應案件，未計入報價金額。`});
  const clients = new Map(rows('clients').map(r=>[text(r.id),r]));
  const receipts = unique(rows('receipts'),'id','duplicate_receipt');
  const allocations = unique(rows('allocations'),'id','duplicate_allocation');
  const invalidInvoice = new Set<string>(); const invalidReceipt = new Set<string>();
  const ambiguousInvoiceIdentity = new Set<string>();
  const invoiceIdCounts=new Map<string,number>(),invoiceNumberCounts=new Map<string,number>();
  for(const invoice of rows('invoices')){
    const id=text(invoice.id),number=text(invoice.number);
    invoiceIdCounts.set(id,(invoiceIdCounts.get(id)??0)+1);
    if(number)invoiceNumberCounts.set(number,(invoiceNumberCounts.get(number)??0)+1);
  }
  for(const invoice of rows('invoices')){
    const id=text(invoice.id),duplicateId=(invoiceIdCounts.get(id)??0)>1;
    if(!id||!text(invoice.number)||duplicateId||(invoiceNumberCounts.get(text(invoice.number))??0)>1){
      invalidInvoice.add(id);
      ambiguousInvoiceIdentity.add(id);
      issues.push({type:duplicateId?'duplicate_invoice_id':'duplicate_invoice',caseId:text(invoice.caseId),description:`發票 ${text(invoice.number)} 的${duplicateId?'內部識別碼':'號碼'}重複或缺漏；收款分配與新案結案暫不認定，請先修正唯一關聯。`});
    }
  }
  for(const a of allocations){
    const r=receipts.find(r=>r.id===a.receiptId),inv=allInvoices.find(i=>i.id===a.invoiceId);
    if(!r||!inv||money(a.amount)===null|| (a.caseId && a.caseId!==inv.caseId)){
      invalidInvoice.add(text(a.invoiceId));invalidReceipt.add(text(a.receiptId));issues.push({type:'allocation',caseId:text(a.caseId),description:'收款分配的關聯或金額無效，應收餘額暫不認定。'});
    }
  }
  for(const r of receipts){
    const allocated=sumKnown(allocations.filter(a=>a.receiptId===r.id).map(a=>money(a.amount)));
    if(money(r.amount)===null || allocated>(money(r.amount)??0)+0.01){invalidReceipt.add(text(r.id));allocations.filter(a=>a.receiptId===r.id).forEach(a=>invalidInvoice.add(text(a.invoiceId)));issues.push({type:'allocation',description:'分配金額超過實收或實收金額未確認。'});}
  }
  for(const inv of allInvoices){
    if(sumKnown(allocations.filter(a=>a.invoiceId===inv.id).map(a=>money(a.amount)))>(money(inv.gross)??Infinity)+0.01){invalidInvoice.add(text(inv.id));issues.push({type:'allocation',caseId:text(inv.caseId),description:'發票分配超過含稅金額，餘額暫不認定。'});}
  }
  const caseList: DerivedCase[] = sourceCases.map(c=>{
    const invoices=validInvoices.filter(i=>i.caseId===c.id);
    const historical=c.mode==='歷史';
    const dates=invoices.map(i=>parseDate(i.date)).filter((d):d is string=>!!d).sort();
    const signed=!!c.signedSourceId && rows('documents').some(d=>d.id===c.signedSourceId) && !!parseDate(c.decisionDate);
    const won=historical ? invoices.length>0 : signed;
    const lost=!won && ['未成交','取消'].includes(text(c.status));
    const saleDate=won ? historical ? dates[0]??null : parseDate(c.decisionDate) : parseDate(c.decisionDate);
    const effective=rows('quotes').filter(q=>q.caseId===c.id&&yes(q.effective));
    const latestQuoteDate=effective.map(q=>parseDate(q.date)).filter((d):d is string=>!!d).sort().at(-1);
    const revisionDate=parseDate(c.revisionSignedDate);
    const revisionDocument=!!c.revisionSignedSourceId&&c.revisionSignedSourceId!==c.signedSourceId&&rows('documents').some(d=>d.id===c.revisionSignedSourceId);
    const needsRevision=!historical&&signed&&!!latestQuoteDate&&latestQuoteDate>parseDate(c.decisionDate)!;
    const resign=needsRevision&&!(revisionDocument&&revisionDate&&revisionDate>=latestQuoteDate!);
    if(resign)issues.push({type:'resign',caseId:text(c.id),description:'有效報價晚於原成交日；請填最新改版簽回日及獨立簽回文件，保留原成交決策日與原簽回文件。'});
    const groups = new Set(effective.map(q=>text(q.groupId||'main')));
    const conflict=[...groups].some(group=>{const versions=effective.filter(q=>text(q.groupId||'main')===group);return versions.length>1&&!complementaryBundle(versions);});
    if(conflict)issues.push({type:'quote_versions',caseId:text(c.id),description:'同一報價組有多個有效版本，請確認唯一成交版本。'});
    // Actual valid invoice net replaces contract snapshots for sales analysis.
    const saleNet = invoices.length?completeSum(invoices.map(i=>money(i.net))):null;
    const expected=money(c.expectedInvoiceGross);
    const schedules=rows('invoiceSchedule').filter(s=>s.caseId===c.id);
    const milestoneTotal=completeSum(schedules.map(s=>money(s.expectedGross)));
    const invoiceTotal=completeSum(invoices.map(i=>money(i.gross)));
    const milestoneInvoiceIds=schedules.map(s=>text(s.invoiceId));
    const milestonesComplete=schedules.length>0 && schedules.every(s=>yes(s.confirmed)&&!!s.invoiceId&&money(s.expectedGross)!==null&&invoices.some(i=>i.id===s.invoiceId&&money(i.gross)!==null&&Math.abs(money(i.gross)!-money(s.expectedGross)!)<0.01)) && new Set(milestoneInvoiceIds).size===milestoneInvoiceIds.length;
    const closed=won && !resign && (historical || !invoices.some(i=>ambiguousInvoiceIdentity.has(text(i.id))) && expected!==null && milestoneTotal!==null && invoiceTotal!==null && milestonesComplete && Math.abs(expected-milestoneTotal)<0.01 && Math.abs(expected-invoiceTotal)<0.01);
    const certified=yes(c.confirmed);
    if(!certified)issues.push({type:'relationship',caseId:text(c.id),description:`${text(c.number)} 案件關聯待確認，未計入正式商機成交率。`});
    // Sheet says 已成交 but the evidence rule is not met: neither won nor pending until the owner fixes the source.
    const unverifiedWon=!won&&text(c.status)==='已成交';
    if(unverifiedWon)issues.push({type:'won_evidence',caseId:text(c.id),description:historical?`${text(c.number)} 商機狀態為已成交，但尚無有效發票；未計入成交，也不列入待成交。`:`${text(c.number)} 商機狀態為已成交，但缺少可辨識的簽回文件ID或成交決策日；未計入成交，也不列入待成交。`});
    if(won&&!saleDate)issues.push({type:'sale_date',caseId:text(c.id),description:'成交依據已存在，但沒有有效日期；無法歸入指定期間。'});
    // 結案 follows the owner's manual 結案狀態 only; the other stages follow the evidence in the sheet.
    const hasQuote=rows('quotes').some(q=>q.caseId===c.id)||text(c.status)==='已報價待確認';
    const stage:CaseStage=lost?'未成交':text(c.closureStatus)==='已結案'?'結案':invoices.length?'開票':(won||unverifiedWon)?'成交':hasQuote?'報價':'提案';
    const stageFlag=unverifiedWon&&stage==='成交'?'成交依據待核對':null;
    const invoicedGross=invoices.length?sumKnown(invoices.map(i=>money(i.gross))):null;
    // 全款／訂金／尾款／追加 from the case's valid invoices, in billing order.
    const paymentTypes=PAYMENT_ORDER.filter(t=>invoices.some(i=>text(i.type).includes(t))).join('＋');
    return {...c,won,lost,closed,stage,stageFlag,invoicedGross,paymentTypes,saleDate,saleNet:won?saleNet:null,historical,certified,unverifiedWon,derivedStatus:won?'已成交':lost?'未成交':unverifiedWon?'待核對':text(c.status)||'待核對'};
  });
  const caseDimensions=caseList.filter(c=>{
    if(filters.brand&&c.brand!==filters.brand)return false;
    if(filters.status&&c.derivedStatus!==filters.status)return false;
    if(filters.search&&!`${c.number} ${c.title} ${clients.get(text(c.clientId))?.name??''}`.toLowerCase().includes(filters.search.toLowerCase()))return false;
    if(filters.activity){const start=parseDate(c.activityStart),end=parseDate(c.activityEnd)||start;if(!start||!end||filters.activity.start&&end<filters.activity.start||filters.activity.end&&start>filters.activity.end)return false;}
    return true;
  });
  const cases=caseDimensions.filter(c=>!filters.clientId||c.clientId===filters.clientId);
  const dimensionIds=new Set(caseDimensions.map(c=>c.id));
  const ids = new Set(cases.map(c=>c.id));
  const period=filters.period;
  const won=cases.filter(c=>c.won&&c.certified&&inPeriod(c.saleDate,period));
  const originalWon=won.filter(c=>!c.parentId);
  const lost=cases.filter(c=>c.lost&&c.certified&&!c.parentId&&inPeriod(c.decisionDate,period));
  const pending=cases.filter(c=>!c.won&&!c.lost&&!c.unverifiedWon&&!c.parentId);
  const caseScoped=!!(filters.brand||filters.status||filters.search||filters.activity);
  const caseNumbers=new Map(sourceCases.map(c=>[text(c.id),text(c.number).trim()]));
  const latestQuotes=selectLatestQuotes(rows('quotes').filter(q=>caseNumbers.has(text(q.caseId))),issues,caseNumbers).filter(q=>q.caseIds.some(id=>ids.has(id)));
  const quoted=latestQuotes.filter(q=>inPeriod(q.date,period));
  const pendingQuoted=quoted.filter(q=>cases.some(c=>q.caseIds.includes(text(c.id))&&!c.won&&!c.lost&&!c.unverifiedWon));
  const quotedAmounts=quoted.map(q=>q.net),pendingAmounts=pendingQuoted.map(q=>q.net);
  const invoices:DerivedInvoice[]=validInvoices.filter(i=>(!caseScoped||dimensionIds.has(i.caseId))&&inPeriod(i.date,period)&&(!filters.clientId||(i.clientId||caseList.find(c=>c.id===i.caseId)?.clientId)===filters.clientId)).map(i=>{
    const assigned=allocations.filter(a=>a.invoiceId===i.id);
    const paid=completeSum(assigned.filter(a=>receipts.some(r=>r.id===a.receiptId&&yes(r.verified)&&!invalidReceipt.has(text(r.id)))).map(a=>money(a.amount)));
    const verified=yes(i.receiptVerified)||yes(caseList.find(c=>c.id===i.caseId)?.receiptVerified);
    const allVerified=assigned.every(a=>receipts.some(r=>r.id===a.receiptId&&yes(r.verified)&&!invalidReceipt.has(text(r.id))));
    const gross=money(i.gross);const balance=verified&&allVerified&&!invalidInvoice.has(text(i.id))&&gross!==null&&paid!==null ? gross-paid : null;
    const overdue=balance!==null&&balance>0&&yes(i.dueConfirmed)&&!!parseDate(i.dueDate)&&parseDate(i.dueDate)!<filters.today;
    return {...i,balance,paid:assigned.length&&!invalidInvoice.has(text(i.id))?paid:null,overdue} as DerivedInvoice;
  });
  // Without case filters, count each verified bank entry once. With case scope, only its approved allocations are attributable.
  const filteredReceipts=receipts.filter(r=>yes(r.verified)&&!invalidReceipt.has(text(r.id))&&inPeriod(r.date,period)&&(!filters.clientId||r.clientId===filters.clientId)&&(!caseScoped||allocations.some(a=>a.receiptId===r.id&&ids.has(a.caseId)&&!invalidInvoice.has(text(a.invoiceId)))));
  const receiptAmounts=caseScoped ? filteredReceipts.map(r=>sumKnown(allocations.filter(a=>a.receiptId===r.id&&ids.has(a.caseId)&&!invalidInvoice.has(text(a.invoiceId))).map(a=>money(a.amount)))) : filteredReceipts.map(r=>money(r.amount));
  const invoiceNets=invoices.map(i=>money(i.net));
  const totalDecisions=originalWon.length+lost.length;
  const rankMap=new Map<string,{clientId:string;name:string;net:number;count:number;unknown:number;knownCount:number;projectIds:Set<string>}>();
  for(const invoice of invoices){const c=caseList.find(c=>c.id===invoice.caseId);const id=text(invoice.clientId||c?.clientId);const r=rankMap.get(id)??{clientId:id,name:text(clients.get(id)?.name)||'客戶未確認',net:0,count:0,unknown:0,knownCount:0,projectIds:new Set<string>()};const net=money(invoice.net);r.net+=net??0;r.unknown+=net===null?1:0;r.knownCount+=net===null?0:1;if(c)r.projectIds.add(text(c.parentId||c.id));r.count=r.projectIds.size;rankMap.set(id,r);}
  const ranking=[...rankMap.values()].sort((a,b)=>b.net-a.net);
  const relevantTasks=rows('tasks').filter(t=>ids.has(t.caseId)&&!['完成','取消'].includes(text(t.status)));
  const followups=[...relevantTasks.map(t=>({id:text(t.id),caseId:text(t.caseId),title:text(t.title),date:parseDate(t.dueDate),kind:'待辦'})),...cases.filter(c=>c.nextFollowupDate||c.nextAction).map(c=>({id:`follow-${c.id}`,caseId:text(c.id),title:text(c.nextAction)||'確認案件下一步',date:parseDate(c.nextFollowupDate),kind:'追案'}))].sort((a,b)=>(a.date??'9999').localeCompare(b.date??'9999'));
  const trends=new Map<string,{month:string;sales:number;invoiced:number;receipts:number;quoted:number;pending:number;salesUnknown:number;invoiceUnknown:number;quotedUnknown:number;pendingUnknown:number;salesKnownCount:number;invoicedKnownCount:number;receiptsKnownCount:number;quotedKnownCount:number;pendingKnownCount:number}>();
  const point=(date:unknown)=>{const d=parseDate(date);if(!d)return null;const month=d.slice(0,7);if(!trends.has(month))trends.set(month,{month,sales:0,invoiced:0,receipts:0,quoted:0,pending:0,salesUnknown:0,invoiceUnknown:0,quotedUnknown:0,pendingUnknown:0,salesKnownCount:0,invoicedKnownCount:0,receiptsKnownCount:0,quotedKnownCount:0,pendingKnownCount:0});return trends.get(month)!;};
  for(const [metric,entries] of [['quoted',quoted],['pending',pendingQuoted]] as const)for(const q of entries){const p=point(q.date);if(p){p[metric]+=q.net??0;p[`${metric}Unknown`]+=q.net===null?1:0;p[`${metric}KnownCount`]+=q.net===null?0:1;}}
  won.forEach(c=>{const p=point(c.saleDate);if(p){p.sales+=c.saleNet??0;p.salesUnknown+=c.saleNet===null?1:0;p.salesKnownCount+=c.saleNet===null?0:1;}});
  invoices.forEach(i=>{const p=point(i.date);if(p){p.invoiced+=money(i.net)??0;p.invoiceUnknown+=money(i.net)===null?1:0;p.invoicedKnownCount+=money(i.net)===null?0:1;}});
  filteredReceipts.forEach((r,index)=>{const p=point(r.date);if(p){p.receipts+=receiptAmounts[index]??0;p.receiptsKnownCount+=receiptAmounts[index]===null?0:1;}});
  const scopedIssues=issues.filter(x=>!x.caseId||ids.has(x.caseId));
  const reconciliation=rows('reconciliation').filter(r=>(!r.caseId||ids.has(r.caseId))&&!['已解決','完成','已確認'].includes(text(r.status)));
  return {cases,invoices,won,pending,latestQuotes,ranking,followups,issues:scopedIssues,reconciliation,trends:[...trends.values()].sort((a,b)=>a.month.localeCompare(b.month)),
    metrics:{quotedNet:completeSum(quotedAmounts),knownQuotedNet:sumKnown(quotedAmounts),quotedCount:quoted.length,unknownQuotedCount:quotedAmounts.filter(v=>v===null).length,pendingQuotedCount:pendingQuoted.length,unknownPendingCount:pendingAmounts.filter(v=>v===null).length,wonCount:originalWon.length,lostCount:lost.length,pendingCount:pending.length,pendingNet:completeSum(pendingAmounts),knownPendingNet:sumKnown(pendingAmounts),ambiguousCount:cases.filter(c=>!c.certified&&!c.parentId).length,winRate:totalDecisions?originalWon.length/totalDecisions*100:null,wonNet:completeSum(won.map(c=>c.saleNet)),knownWonNet:sumKnown(won.map(c=>c.saleNet)),unknownWonCount:won.filter(c=>c.saleNet===null).length,invoiceNet:completeSum(invoiceNets),knownInvoiceNet:sumKnown(invoiceNets),invoiceCount:invoices.length,invoiceGross:completeSum(invoices.map(i=>money(i.gross))),receiptsGross:filteredReceipts.length?completeSum(receiptAmounts):null,receiptCount:filteredReceipts.length,outstandingGross:invoices.length?completeSum(invoices.map(i=>i.balance)):null,knownOutstandingGross:sumKnown(invoices.map(i=>i.balance)),unknownReceiptCount:invoices.filter(i=>i.balance===null).length,overdueGross:sumKnown(invoices.filter(i=>i.overdue).map(i=>i.balance)),closedCount:cases.filter(c=>c.closed).length},
    taxUnconfirmedCount:invoices.filter(i=>!yes(i.taxConfirmed)).length,
    coverage:{start:parseDate(rows('settings').find(r=>r.key==='coverage_start')?.value),end:parseDate(rows('settings').find(r=>r.key==='coverage_end')?.value)},
  };
}
