import test from 'node:test';
import assert from 'node:assert/strict';
import { derive, makePeriod, parseDate, compare, applyRefresh } from '../lib/domain/analytics.ts';
const base = () => ({ clients:[],cases:[],quotes:[],quoteItems:[],invoices:[],invoiceSchedule:[],receipts:[],allocations:[],tasks:[],documents:[],reconciliation:[],settings:[] });
const c = (more={}) => ({id:'c1',number:'A001',title:'測試案',mode:'歷史',confirmed:true,clientId:'u1',...more});
const i = (more={}) => ({id:'i1',number:'TEST0001',caseId:'c1',date:'2026-11-02',gross:1050,net:1000,tax:50,taxConfirmed:true,status:'有效',...more});
const all = {period:{start:null,end:null},today:'2026-11-14'};
test('historical invoice proves won and closure and supplies sold net without inventing receipt',()=>{
 const d=base();d.cases=[c()];d.invoices=[i()];const a=derive(d,all);
 assert.equal(a.cases[0].won,true);assert.equal(a.cases[0].closed,true);assert.equal(a.cases[0].saleDate,'2026-11-02');assert.equal(a.metrics.wonNet,1000);assert.equal(a.metrics.knownWonNet,1000);assert.equal(a.metrics.receiptsGross,null);assert.equal(a.metrics.outstandingGross,null);
});
test('duplicate invoice numbers cannot inflate turnover; unknown tax never becomes net',()=>{
 const d=base();d.cases=[c()];d.invoices=[i({net:null,tax:null,taxConfirmed:false}),i({id:'duplicate'})];const a=derive(d,all);
 assert.equal(a.metrics.invoiceNet,null);assert.equal(a.metrics.invoiceCount,1);assert.ok(a.issues.some(x=>x.type==='duplicate_invoice'));
});
test('same A280 number stays distinct and unconfirmed relationships are excluded from certified rate',()=>{
 const d=base();d.cases=[c({id:'a',number:'A280',confirmed:false}),c({id:'b',number:'A280',confirmed:false})];d.invoices=[i({caseId:'a'}),i({id:'i2',number:'TEST0002',caseId:'b'})];const a=derive(d,all);
 assert.equal(a.cases.length,2);assert.equal(a.metrics.wonCount,0);assert.equal(a.metrics.ambiguousCount,2);assert.equal(a.metrics.winRate,null);
});
test('addition retains sold amount but is not another original opportunity or customer',()=>{
 const d=base();d.cases=[c({wonNet:1000}),c({id:'add',number:'A001-1',parentId:'c1',wonNet:200})];d.invoices=[i(),i({id:'i2',number:'TEST0002',caseId:'add',net:200,gross:210})];const a=derive(d,all);
 assert.equal(a.metrics.wonCount,1);assert.equal(a.metrics.wonNet,1200);assert.equal(a.ranking.length,1);
});
test('quote version conflicts stay visible without suppressing actual invoice sales',()=>{
 const d=base();d.cases=[c(),c({id:'pending',mode:'新案',status:'已報價待確認'})];d.invoices=[i()];d.quotes=[{id:'q1',caseId:'c1',effective:true,groupId:'g',net:100},{id:'q2',caseId:'c1',effective:true,groupId:'g',net:200},{id:'q3',caseId:'pending',effective:false,net:900,date:'2026-11-01'}];const a=derive(d,all);
 assert.equal(a.metrics.wonNet,1000);assert.equal(a.metrics.pendingCount,1);assert.ok(a.issues.some(x=>x.type==='quote_versions'));
});
test('addition-only quote does not replace actual invoice sales',()=>{
 const d=base();d.cases=[c()];d.invoices=[i()];d.quotes=[{id:'q1',caseId:'c1',effective:true,role:'追加',net:5936}];assert.equal(derive(d,all).metrics.wonNet,1000);
});
test('new cases require signed document and date; complete amount alone never closes missing milestones',()=>{
 const d=base();d.cases=[c({mode:'新案',status:'已成交',decisionDate:'2026-11-02',wonNet:1000,expectedInvoiceGross:1050})];d.invoices=[i()];assert.equal(derive(d,all).cases[0].won,false);
 d.cases[0].signedSourceId='s';d.documents=[{id:'s',url:'https://drive.google.com/file/d/test/view'}];assert.equal(derive(d,all).cases[0].won,true);assert.equal(derive(d,all).cases[0].closed,false);
 d.invoiceSchedule=[{id:'s1',caseId:'c1',expectedGross:1050,confirmed:true,invoiceId:'i1'}];assert.equal(derive(d,all).cases[0].closed,true);
 d.invoiceSchedule.push({id:'s2',caseId:'c1',expectedGross:100,confirmed:true});assert.equal(derive(d,all).cases[0].closed,false);
});
test('post-sale cancellation preserves signed history; pre-sale cancellation is lost',()=>{
 const d=base();d.cases=[c({mode:'新案',status:'取消',decisionDate:'2026-11-02',signedSourceId:'s',wonNet:100}),c({id:'lost',mode:'新案',status:'取消',decisionDate:'2026-11-03'})];d.documents=[{id:'s'}];const a=derive(d,all);assert.equal(a.metrics.wonCount,1);assert.equal(a.metrics.lostCount,1);assert.equal(a.metrics.winRate,50);
});
test('confirmed partial allocations yield gross balance; missing due confirmation cannot become overdue',()=>{
 const d=base();d.cases=[c()];d.invoices=[i({receiptVerified:true,dueDate:'2026-11-01',dueConfirmed:false})];d.receipts=[{id:'r',amount:600,verified:true,date:'2026-11-03'}];d.allocations=[{id:'a',receiptId:'r',invoiceId:'i1',caseId:'c1',amount:600}];const a=derive(d,all);
 assert.equal(a.metrics.receiptsGross,600);assert.equal(a.metrics.outstandingGross,450);assert.equal(a.metrics.overdueGross,0);
 d.allocations.push({id:'b',receiptId:'r',invoiceId:'i1',caseId:'c1',amount:100});assert.equal(derive(d,all).metrics.outstandingGross,null);
});
test('activity overlap is optional and does not prorate or duplicate money',()=>{
 const d=base();d.cases=[c({wonNet:1000,activityStart:'2026-10-30',activityEnd:'2026-11-03'})];d.invoices=[i()];assert.equal(derive(d,{...all,activity:{start:'2026-11-01',end:'2026-11-30'}}).metrics.wonNet,1000);assert.equal(derive(d,{...all,activity:{start:'2026-12-01',end:'2026-12-31'}}).cases.length,0);
});
test('calendar comparison clamps month end and leap years, serial dates are accepted',()=>{
 assert.equal(makePeriod('month','2026-03-31','2026-03-31').previous.end,'2026-02-28');assert.equal(makePeriod('year','2024-02-29','2024-02-29').previous.end,'2023-02-28');assert.equal(parseDate(45292),'2024-01-01');assert.equal(parseDate('2026-02-30'),null);
});
test('missing, zero or uncovered comparison baseline is unavailable',()=>{
 assert.equal(compare(20,0,true),null);assert.equal(compare(20,null,true),null);assert.equal(compare(20,10,false),null);assert.equal(compare(20,10,true),100);
});
test('failed refresh keeps last data explicitly stale and never substitutes a fixture',()=>{
 const prev={data:{cases:[{id:'a'}]},loadedAt:'2026-11-14T01:00:00Z',stale:false};const next=applyRefresh(prev,{status:'tool_error',message:'offline'});assert.deepEqual(next.data,prev.data);assert.equal(next.stale,true);assert.equal(next.loadedAt,prev.loadedAt);assert.equal(applyRefresh({}, {status:'tool_error'}).data,undefined);
});
test('recorded invoice net is preserved even while tax needs confirmation',()=>{
 const d=base();d.cases=[c()];d.invoices=[i({taxConfirmed:false,tax:null})];const a=derive(d,all);assert.equal(a.metrics.invoiceNet,1000);assert.equal(a.taxUnconfirmedCount,1);
});
test('unknown amounts do not produce zero-valued known chart points or ranks',()=>{
 const d=base();d.cases=[c()];d.invoices=[i({net:null})];const a=derive(d,all);assert.equal(a.trends[0].salesKnownCount,0);assert.equal(a.trends[0].invoicedKnownCount,0);assert.equal(a.trends[0].receiptsKnownCount,0);assert.equal(a.ranking[0].knownCount,0);
});
test('invoice buyer filter follows the invoice buyer, preserving a case buyer mismatch for reconciliation',()=>{
 const d=base();d.cases=[c({clientId:'original'})];d.invoices=[i({clientId:'invoice-buyer'})];assert.equal(derive(d,{...all,clientId:'invoice-buyer'}).metrics.invoiceNet,1000);assert.equal(derive(d,{...all,clientId:'original'}).metrics.invoiceCount,0);
});
test('an effective new quote dated after signed decision requires renewed signature date',()=>{
 const d=base();d.cases=[c({mode:'新案',signedSourceId:'s',decisionDate:'2026-11-01',wonNet:1000})];d.documents=[{id:'s'}];d.quotes=[{id:'q',caseId:'c1',date:'2026-11-04',effective:true}];const a=derive(d,all);assert.equal(a.cases[0].won,true);assert.equal(a.cases[0].saleNet,null);assert.equal(a.cases[0].closed,false);assert.ok(a.issues.some(i=>i.type==='resign'));
});
test('pending quote amounts remain separate from sold totals and use the latest dated version',()=>{
 const d=base();d.cases=[c({mode:'新案',status:'已報價待確認'})];d.quotes=[{id:'q',caseId:'c1',net:500,groupId:'main',date:'2026-11-01'}];let a=derive(d,all);assert.equal(a.metrics.pendingNet,500);assert.equal(a.metrics.wonNet,0);d.quotes.push({id:'q2',caseId:'c1',net:600,groupId:'main',date:'2026-11-03'});assert.equal(derive(d,all).metrics.pendingNet,600);
});
test('verified but unallocated bank receipt is unknown for a selected case scope',()=>{
 const d=base();d.cases=[c({brand:'test'})];d.receipts=[{id:'r',verified:true,amount:500,date:'2026-11-01'}];assert.equal(derive(d,{...all,brand:'test'}).metrics.receiptsGross,null);assert.equal(derive(d,all).metrics.receiptsGross,500);
});
test('unlinked effective invoice stays in overall finance and is queued instead of silently disappearing',()=>{
 const d=base();d.invoices=[i({caseId:'missing'})];const a=derive(d,all);assert.equal(a.metrics.invoiceGross,1050);assert.ok(a.issues.some(x=>x.type==='case_reference'));
});
test('confirmed due date works for native serial dates as well as ISO dates',()=>{
 const d=base();d.cases=[c()];d.invoices=[i({dueDate:45292,dueConfirmed:true,receiptVerified:true})];assert.equal(derive(d,all).metrics.overdueGross,1050);
});
test('new closure checks each invoice milestone amount, not only matching grand totals',()=>{
 const d=base();d.cases=[c({mode:'新案',signedSourceId:'s',decisionDate:'2026-11-01',expectedInvoiceGross:1050})];d.documents=[{id:'s'}];d.invoices=[i({gross:1000}),i({id:'i2',number:'TEST0002',gross:50})];d.invoiceSchedule=[{id:'s1',caseId:'c1',expectedGross:500,invoiceId:'i1',confirmed:true},{id:'s2',caseId:'c1',expectedGross:550,invoiceId:'i2',confirmed:true}];assert.equal(derive(d,all).cases[0].closed,false);
});
test('duplicate internal invoice IDs never reuse one allocation to certify two paid invoices or closures',()=>{
 const d=base();d.cases=[c({mode:'新案',signedSourceId:'s',decisionDate:'2026-11-01',expectedInvoiceGross:1050,receiptVerified:true}),c({id:'c2',mode:'新案',signedSourceId:'s',decisionDate:'2026-11-01',expectedInvoiceGross:1050,receiptVerified:true})];d.documents=[{id:'s'}];d.invoices=[i(),i({number:'TEST0002',caseId:'c2'})];d.receipts=[{id:'r',amount:1050,date:'2026-11-02',verified:true}];d.allocations=[{id:'a',receiptId:'r',invoiceId:'i1',caseId:'c1',amount:1050}];d.invoiceSchedule=[{id:'ms1',caseId:'c1',invoiceId:'i1',expectedGross:1050,confirmed:true},{id:'ms2',caseId:'c2',invoiceId:'i1',expectedGross:1050,confirmed:true}];
 const a=derive(d,all);assert.equal(a.metrics.invoiceGross,2100);assert.equal(a.metrics.receiptsGross,1050);assert.equal(a.metrics.outstandingGross,null);assert.ok(a.invoices.every(i=>i.balance===null&&i.paid===null));assert.ok(a.cases.every(c=>c.closed===false));assert.ok(a.issues.some(i=>i.type==='duplicate_invoice_id'));
});
test('revision signing clears the changed quote without moving the original opportunity decision period',()=>{
 const d=base();d.cases=[c({mode:'新案',signedSourceId:'original-sign',decisionDate:'2026-10-15',wonNet:1000,expectedInvoiceGross:1050,revisionSignedDate:'2026-11-05',revisionSignedSourceId:'revision-sign'})];d.documents=[{id:'original-sign'},{id:'revision-sign'}];d.quotes=[{id:'q',caseId:'c1',date:'2026-11-03',effective:true,net:1000}];d.invoices=[i()];d.invoiceSchedule=[{id:'ms',caseId:'c1',invoiceId:'i1',expectedGross:1050,confirmed:true}];
 const oct=derive(d,{...all,period:{start:'2026-10-01',end:'2026-10-31'}}),nov=derive(d,{...all,period:{start:'2026-11-01',end:'2026-11-30'}});assert.equal(oct.metrics.wonCount,1);assert.equal(oct.metrics.wonNet,1000);assert.equal(nov.metrics.wonCount,0);assert.equal(oct.cases[0].saleDate,'2026-10-15');assert.equal(oct.cases[0].closed,true);assert.equal(oct.issues.some(i=>i.type==='resign'),false);
 for(const change of [{revisionSignedDate:'2026-11-02'},{revisionSignedSourceId:'missing'},{revisionSignedDate:null}]){const invalid=structuredClone(d);Object.assign(invalid.cases[0],change);const a=derive(invalid,all);assert.equal(a.cases[0].saleNet,1000);assert.equal(a.cases[0].saleDate,'2026-10-15');assert.equal(a.cases[0].closed,false);}
});
test('pending financial amount uses quote-date period while current pending count stays operational',()=>{
 const d=base();d.cases=[c({mode:'新案',status:'已報價待確認'})];d.quotes=[{id:'q1',caseId:'c1',date:'2026-10-10',net:500,groupId:'g'},{id:'q2',caseId:'c1',date:'2026-11-03',net:700,groupId:'g'}];const nov=derive(d,{...all,period:{start:'2026-11-01',end:'2026-11-30'}}),dec=derive(d,{...all,period:{start:'2026-12-01',end:'2026-12-31'}});assert.equal(nov.metrics.pendingNet,700);assert.equal(dec.metrics.pendingNet,0);assert.equal(dec.metrics.pendingCount,1);
});
test('fully invoiced new case closes independently of invalid receipt allocations',()=>{
 const d=base();d.cases=[c({mode:'新案',signedSourceId:'signed',decisionDate:'2026-11-01',expectedInvoiceGross:1050,receiptVerified:true})];d.documents=[{id:'signed'}];d.invoices=[i()];d.invoiceSchedule=[{id:'milestone',caseId:'c1',invoiceId:'i1',expectedGross:1050,confirmed:true}];d.receipts=[{id:'receipt',amount:500,date:'2026-11-02',verified:true}];d.allocations=[{id:'allocation',caseId:'c1',invoiceId:'i1',receiptId:'receipt',amount:600}];
 const a=derive(d,all);assert.equal(a.cases[0].closed,true);assert.equal(a.invoices[0].balance,null);assert.ok(a.issues.some(issue=>issue.type==='allocation'));
});
