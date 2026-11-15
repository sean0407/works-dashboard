import test from 'node:test';
import assert from 'node:assert/strict';
import {derive} from '../lib/domain/analytics.ts';
import {documentCoverage} from '../lib/domain/coverage.ts';
const p={start:'2026-01-01',end:'2026-12-31'},filters={period:p,today:'2026-11-15'};
const c=(id,more={})=>({id,number:id,mode:'歷史',confirmed:true,clientId:'u',...more});
const q=(id,caseId,more={})=>({id,caseId,date:'2026-05-01',net:100,sourceId:id,...more});
const i=(id,caseId,more={})=>({id,number:id,caseId,date:'2026-06-01',net:100,gross:105,status:'有效',sourceId:id,...more});
const doc=(id,kind)=>({id,kind,filename:id+'.pdf',url:'https://drive.google.com/file/d/'+id+'/view'});
const run=(d,f=filters)=>documentCoverage(d,derive(d,f),f.period);
test('lists invoice-only, quote-only and matched roots instead of subtracting KPI totals',()=>{
 const d={cases:[c('both'),c('invoice'),c('quote')],quotes:[q('q1','both'),q('q2','quote')],invoices:[i('i1','both'),i('i2','invoice')],documents:[doc('q1','報價單'),doc('q2','報價單'),doc('i1','發票'),doc('i2','發票')]};
 const a=run(d);assert.equal(a.summary.matchedWins,1);assert.equal(a.summary.wonOnly,1);assert.equal(a.summary.quoteOnly,1);assert.equal(a.rows.find(r=>r.id==='invoice').missingQuote,true);assert.equal(a.rows.find(r=>r.id==='quote').missingQuote,false);assert.ok(a.rows.find(r=>r.id==='quote').reasons.includes('尚無發票，不代表失單或欠款'));
});
test('an old quotation outside the period is a present document even if absent from the quote KPI cohort',()=>{
 const a=run({cases:[c('a')],quotes:[q('q','a',{date:'2025-01-01'})],invoices:[i('i','a')],documents:[doc('q','報價單'),doc('i','發票')]});assert.equal(a.summary.wonOnly,1);assert.equal(a.rows[0].missingQuote,false);assert.ok(a.rows[0].reasons.includes('報價在其他期間或未列最新報價KPI'));
});
test('a quotation without a win in this period may already have won in another period',()=>{
 const f={...filters,period:{start:'2026-10-01',end:'2026-10-31'}};
 const a=run({cases:[c('a')],quotes:[q('q','a',{date:'2026-10-20'})],invoices:[i('i','a',{date:'2026-09-30'})],documents:[doc('q','報價單'),doc('i','發票')]},f);
 assert.equal(a.rows[0].cohort,'quoteOnly');assert.equal(a.rows[0].wonEver,true);assert.ok(a.rows[0].reasons.includes('已成交，成交認定日在其他期間'));assert.equal(a.rows[0].needsReview,false);
});
test('addition documents roll into their original project without a fake extra missing-case row',()=>{
 const a=run({cases:[c('a'),c('add',{parentId:'a'})],quotes:[q('q','add')],invoices:[i('i','a'),i('i2','add')],documents:[doc('q','報價單'),doc('i','發票'),doc('i2','發票')]});assert.equal(a.rows.length,1);assert.equal(a.rows[0].quoteCount,1);assert.equal(a.rows[0].invoiceCount,2);assert.equal(a.summary.matchedWins,1);
});
test('missing source links and financial fields are listed separately from absent quotations',()=>{
 const a=run({cases:[c('a')],quotes:[q('q','a',{net:null,date:null})],invoices:[i('i','a')],documents:[{id:'q',kind:'報價單',filename:'q.pdf'}]});assert.equal(a.rows[0].missingQuote,false);assert.ok(a.rows[0].reasons.includes('報價日期或未稅金額待補'));assert.ok(a.rows[0].reasons.includes('報價原檔缺連結'));assert.ok(a.rows[0].reasons.includes('發票原檔缺連結'));
});
test('unlinked or unreadable source documents stay visible without inventing invoices or revenue',()=>{
 const d={cases:[],quotes:[],invoices:[],documents:[{...doc('bad','發票'),reviewNotes:'發票號碼無法讀取'}]};const a=run(d);assert.equal(a.unlinkedDocuments.length,1);assert.equal(a.rows.length,0);assert.equal(derive(d,filters).metrics.invoiceNet,0);
});
test('a same-number unlinked file is a candidate, not automatically accepted as the missing quote',()=>{
 const a=run({cases:[c('a')],quotes:[],invoices:[i('i','a')],documents:[doc('i','發票'),{...doc('unreadable','報價單'),caseNumber:'a'}]});
 assert.equal(a.rows[0].missingQuote,true);assert.equal(a.rows[0].candidateFiles.length,1);assert.ok(a.rows[0].reasons.includes('有同案號原件尚未配對，請核對'));
});
test('case/client filters do not reveal unrelated document coverage rows',()=>{
 const d={cases:[c('a'),c('b',{clientId:'other'})],invoices:[i('i','a'),i('j','b')],quotes:[],documents:[]};const a=run(d,{...filters,clientId:'u'});assert.deepEqual(a.rows.map(r=>r.id),['a']);
});
