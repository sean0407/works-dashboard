import test from 'node:test';
import assert from 'node:assert/strict';
import {derive} from '../lib/domain/analytics.ts';
const all={period:{start:null,end:null},today:'2026-11-15'};
const period=(start,end)=>({...all,period:{start,end}});
const c=(id,more={})=>({id,number:id,mode:'歷史',confirmed:true,clientId:'buyer',...more});
const q=(id,caseId,date,net,more={})=>({id,caseId,date,net,...more});
const inv=(id,caseId,net,more={})=>({id,number:id,caseId,net,gross:net==null?null:net*1.05,status:'有效',date:'2026-11-02',...more});

test('quotation total selects latest per case number before applying the date filter',()=>{
 const d={cases:[c('a',{number:'A001'}),c('b',{number:'A002'})],quotes:[q('old','a','2026-10-01',100,{effective:true}),q('new','a','2026-11-01',200),q('other','b','2026-10-01',300)]};
 assert.equal(derive(d,all).metrics.quotedNet,500);
 assert.equal(derive(d,period('2026-10-01','2026-10-31')).metrics.quotedNet,300);
 assert.equal(derive(d,period('2026-11-01','2026-11-30')).metrics.quotedCount,1);
 assert.equal(derive(d,all).latestQuotes.find(x=>x.caseId==='a').quote.id,'new');
});
test('same original number across internal projects counts only the latest quote globally',()=>{
 const d={cases:[c('old',{number:'REUSED',clientId:'old-buyer'}),c('new',{number:'REUSED',clientId:'new-buyer'})],quotes:[q('old','old','2026-09-30',4624498),q('new','new','2026-10-15',948006)]};
 assert.equal(derive(d,all).metrics.quotedNet,948006);assert.equal(derive(d,all).metrics.quotedCount,1);assert.equal(derive(d,{...all,clientId:'old-buyer'}).metrics.quotedNet,0);
});
test('an unresolved same-number group only flags clients that participate in it',()=>{
 const d={cases:[c('a',{number:'A001',clientId:'a'}),c('b',{number:'A001',clientId:'b'}),c('other',{number:'A002',clientId:'other'})],quotes:[q('a','a','2026-11-01',100),q('b','b','2026-11-01',200)]};
 assert.equal(derive(d,{...all,clientId:'other'}).issues.filter(i=>i.type==='latest_quote').length,0);
 assert.equal(derive(d,{...all,clientId:'a'}).issues.filter(i=>i.type==='latest_quote').length,1);
});
test('pending KPI amount and count use the same latest quoted cases and date scope',()=>{
 const d={cases:[c('pending',{mode:'新案'}),c('lost',{mode:'新案',status:'取消'}),c('won'),c('inquiry',{mode:'新案'}),c('old',{mode:'新案'})],quotes:[q('p','pending','2026-11-01',500),q('l','lost','2026-11-01',600),q('w','won','2026-11-01',700),q('o','old','2026-10-01',800)],invoices:[inv('i','won',700)]};
 const a=derive(d,period('2026-11-01','2026-11-30'));assert.equal(a.metrics.pendingNet,500);assert.equal(a.metrics.pendingQuotedCount,1);assert.equal(a.metrics.pendingCount,3);
});
test('same day V numbers determine latest, unresolved ties stay unknown independent of row order',()=>{
 const d={cases:[c('a')],quotes:[q('a','a','2026-11-01',100,{version:'V1'}),q('b','a','2026-11-01',200,{version:'V2'})]};
 assert.equal(derive(d,all).metrics.quotedNet,200);d.quotes.reverse();assert.equal(derive(d,all).metrics.quotedNet,200);
 d.quotes.push(q('c','a','2026-11-01',300,{version:'V2'}));const a=derive(d,all);assert.equal(a.metrics.quotedNet,null);assert.equal(a.metrics.quotedCount,1);assert.ok(a.issues.some(i=>i.type==='latest_quote'));
});
test('explicit same-day effective selection resolves a tie, but cannot resurrect an older dated quote',()=>{
 const d={cases:[c('a')],quotes:[q('a','a','2026-11-01',100,{effective:false}),q('b','a','2026-11-01',200,{effective:true})]};
 assert.equal(derive(d,all).metrics.quotedNet,200);
 d.quotes.push(q('new','a','2026-11-02',300,{effective:false}));assert.equal(derive(d,all).metrics.quotedNet,300);
});
test('a same-day higher V version supersedes an old effective flag',()=>{
 const a=derive({cases:[c('a')],quotes:[q('old','a','2026-11-01',100,{version:'V1',effective:true}),q('new','a','2026-11-01',200,{version:'V2',effective:false})]},all);
 assert.equal(a.metrics.quotedNet,200);assert.equal(a.latestQuotes[0].quote.id,'new');
});
test('highest same-day V version may itself be a confirmed complementary bundle',()=>{
 const common={groupId:'bundle',role:'互補',effective:true};
 const a=derive({cases:[c('a')],quotes:[q('old','a','2026-11-01',10,{...common,version:'V1'}),q('new1','a','2026-11-01',100,{...common,version:'V2'}),q('new2','a','2026-11-01',200,{...common,version:'V2'})]},all);
 assert.equal(a.metrics.quotedNet,300);assert.equal(a.latestQuotes[0].quotes.length,2);
});
test('confirmed complementary bundle counts both documents once as one quoted and pending case',()=>{
 const d={cases:[c('a',{mode:'新案'})],quotes:[q('a','a','2026-11-01',93548,{groupId:'bundle',role:'互補',version:'原檔',effective:true}),q('b','a','2026-11-01',399883,{groupId:'bundle',role:'互補',version:'原檔',effective:true})]};
 const a=derive(d,all);assert.equal(a.metrics.quotedNet,493431);assert.equal(a.metrics.quotedCount,1);assert.equal(a.metrics.pendingQuotedCount,1);assert.equal(a.latestQuotes[0].quotes.length,2);assert.equal(a.issues.some(i=>i.type==='quote_versions'),false);
 d.quotes[1].groupId='different';assert.equal(derive(d,all).metrics.quotedNet,null);
});
test('invoice totals replace sold amounts without duplicating invoices or original opportunity counts',()=>{
 const d={cases:[c('a',{wonNet:999}),c('add',{parentId:'a',wonNet:888})],invoices:[inv('i','a',100),inv('j','a',200),inv('k','add',50),inv('void','a',500,{status:'作廢'}),inv('dup','a',100,{number:'i'})]};
 const a=derive(d,all);assert.equal(a.cases[0].saleNet,300);assert.equal(a.metrics.wonNet,350);assert.equal(a.metrics.wonCount,1);assert.equal(a.metrics.invoiceNet,350);
});
test('customer contribution follows invoice buyer and invoice date even for unlinked invoices',()=>{
 const d={cases:[c('a')],clients:[{id:'payer',name:'付款人'}],invoices:[inv('i','a',100,{date:'2026-10-01',clientId:'payer'}),inv('j','a',200,{clientId:'payer'}),inv('k','missing',50,{clientId:'payer'})]};
 const a=derive(d,period('2026-11-01','2026-11-30'));assert.equal(a.ranking[0].net,250);assert.equal(a.ranking[0].clientId,'payer');assert.equal(a.ranking[0].count,1);
});
test('missing quote dates and net are unknown, never inferred from gross or an older version',()=>{
 const d={cases:[c('a'),c('b')],quotes:[q('a','a','2026-11-01',100),q('b','a',null,200),q('c','b','2026-11-01',null,{gross:1050})]};
 const a=derive(d,all);assert.equal(a.metrics.quotedNet,null);assert.equal(a.metrics.unknownQuotedCount,2);assert.equal(a.metrics.knownQuotedNet,0);assert.ok(a.issues.some(i=>i.type==='latest_quote'));
});
test('a sole quote with an invalid date cannot be confirmed as the latest version',()=>{
 const a=derive({cases:[c('a',{mode:'新案'})],quotes:[q('only','a',null,200)]},all);
 assert.equal(a.metrics.quotedNet,null);assert.equal(a.metrics.pendingNet,null);assert.equal(a.metrics.unknownQuotedCount,1);assert.ok(a.issues.some(i=>i.type==='latest_quote'));
});
test('quotation and pending trend amounts match latest-only KPI totals; original records remain unchanged',()=>{
 const d={cases:[c('a',{mode:'新案'})],quotes:[q('old','a','2026-10-01',100),q('new','a','2026-11-01',200)]};const before=structuredClone(d);const a=derive(d,all);
 assert.equal(a.trends.reduce((s,p)=>s+p.quoted,0),200);assert.equal(a.trends.reduce((s,p)=>s+p.pending,0),200);assert.deepEqual(d,before);
});

test('an addition sharing its parent case number adds to the quote total instead of replacing the parent quote',()=>{
 const d={cases:[c('p',{number:'X001',mode:'新案'}),c('add',{number:'X001',mode:'新案',parentId:'p'})],quotes:[q('qp','p','2026-03-01',100000),q('qa','add','2026-04-01',20000,{role:'追加'})]};
 const a=derive(d,all);
 assert.equal(a.metrics.quotedNet,120000);assert.equal(a.metrics.quotedCount,2);
 assert.equal(a.latestQuotes.find(x=>x.caseId==='p').quote.id,'qp');
});
test('a dated quote added by the PDF importer waits for review instead of replacing the manual version',()=>{
 const d={cases:[c('a',{number:'A001',mode:'新案'})],quotes:[q('manual','a','2026-03-01',100000,{version:'V1'}),q('auto','a','2026-03-05',999,{notes:'自動匯入：金額由 PDF 文字讀出，請對照原件後再採用'})]};
 const a=derive(d,all);
 assert.equal(a.metrics.quotedNet,100000);assert.ok(a.pendingImportIds.has('auto'));
 assert.ok(a.issues.some(x=>x.type==='import_review'&&x.caseId==='a'));
 d.quotes[1].notes='已核對';assert.equal(derive(d,all).metrics.quotedNet,999,'clearing the note lets the newer version count');
});
test('a voided invoice listed before its valid twin with the same number does not hide the valid one',()=>{
 const d={cases:[c('a')],invoices:[inv('n','a',100,{id:'void',status:'作廢'}),inv('n','a',100,{id:'valid'})]};
 assert.equal(derive(d,all).metrics.invoiceNet,100);
 d.invoices.reverse();assert.equal(derive(d,all).metrics.invoiceNet,100);
});
test('an imported invoice still 待核對 is not counted and is reported as an import to review, not an unreadable value',()=>{
 const d={cases:[c('a')],invoices:[inv('i1','a',100,{status:'待核對'})]};
 const a=derive(d,all);
 assert.equal(a.metrics.invoiceCount,0);
 assert.ok(a.issues.some(x=>x.type==='import_review'));assert.ok(!a.issues.some(x=>x.type==='invalid_value'));
});

test('a 待核對 import sharing a number with a valid invoice is still listed for review',()=>{
 const d={cases:[c('a')],invoices:[inv('n','a',100,{id:'valid'}),inv('n','a',100,{id:'imp',status:'待核對'})]};
 const a=derive(d,all);
 assert.equal(a.metrics.invoiceNet,100);assert.ok(a.issues.some(x=>x.type==='import_review'));
});
test('an unreviewed imported quote marked effective does not ask for a re-signed revision',()=>{
 const d={cases:[c('a',{number:'A001',mode:'新案',signedSourceId:'s',decisionDate:'2026-03-01'})],documents:[{id:'s'}],quotes:[q('v1','a','2026-02-01',100,{effective:true}),q('auto','a','2026-04-01',90,{effective:true,notes:'自動匯入：請核對'})]};
 const a=derive(d,all);
 assert.ok(!a.issues.some(x=>x.type==='resign'));assert.ok(!a.issues.some(x=>x.type==='quote_versions'));
});
test('a 原案ID pointing to no case is flagged and its quote is not treated as an addition',()=>{
 const d={cases:[c('o',{number:'X009',mode:'新案',parentId:'ghost'})],quotes:[q('qo','o','2026-03-01',100)]};
 const a=derive(d,all);
 assert.ok(a.issues.some(x=>x.type==='relationship'&&x.caseId==='o'&&/找不到/.test(x.description)));
 assert.equal(a.metrics.quotedNet,100);
});
