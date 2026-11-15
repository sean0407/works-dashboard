import test from 'node:test';
import assert from 'node:assert/strict';
import schema from '../lib/domain/schema.json' with {type:'json'};
import {derive} from '../lib/domain/analytics.ts';
import {normalizeMaintenance} from '../lib/domain/maintenance.ts';
import {parseSheet} from '../lib/domain/workbook.ts';

const all={period:{start:null,end:null},today:'2026-11-15'};
const base=()=>({clients:[{id:'k',name:'K'}],documents:[{id:'d1'}],settings:[],receipts:[],quotes:[]});
const signedCase={id:'c',number:'A1',mode:'新案',confirmed:true,signedSourceId:'d1',decisionDate:'2026-06-01',expectedInvoiceGross:1050,clientId:'k'};
const inv=o=>({id:'i',number:'AB1',caseId:'c',status:'有效',date:'2026-06-02',net:1000,tax:50,gross:1050,scheduleId:'p',expectedGross:1050,scheduleConfirmed:true,...o});
const run=d=>derive(normalizeMaintenance({...base(),...d}),all);

test('voided invoice keeping its plan ID does not block closure of the reissued invoice',()=>{
 const a=run({cases:[signedCase],invoices:[inv({id:'v',number:'AB0',status:'作廢'}),inv({})]});
 assert.equal(a.cases[0].closed,true);
 assert.equal(a.metrics.invoiceNet,1000);
});

test('voided invoice alone leaves the plan unfulfilled',()=>{
 const a=run({cases:[signedCase],invoices:[inv({status:'作廢'})]});
 assert.equal(a.cases[0].closed,false);
 assert.equal(a.metrics.invoiceCount,0);
});

test('已成交 without evidence is neither won nor pending and is queued for review',()=>{
 const a=run({cases:[{id:'c',number:'A1',mode:'新案',confirmed:true,status:'已成交'}],invoices:[],quotes:[{id:'q',caseId:'c',date:'2026-06-01',net:500}]});
 assert.equal(a.cases[0].derivedStatus,'待核對');
 assert.equal(a.metrics.wonCount,0);
 assert.equal(a.metrics.pendingCount,0);
 assert.equal(a.metrics.pendingQuotedCount,0);
 assert.equal(a.metrics.pendingNet,0);
 assert.equal(a.metrics.quotedNet,500);
 assert.ok(a.issues.some(i=>i.type==='won_evidence'&&i.caseId==='c'));
});

test('historical 已成交 without a valid invoice is flagged the same way',()=>{
 const a=run({cases:[{id:'h',number:'H1',mode:'歷史',confirmed:true,status:'已成交'}],invoices:[]});
 assert.equal(a.cases[0].won,false);
 assert.ok(a.issues.some(i=>i.type==='won_evidence'&&i.caseId==='h'));
});

test('status cells are trimmed when read from the sheet',()=>{
 const def=schema.collections.invoices,keys=Object.keys(def.columns);
 const rows=parseSheet('invoices',[Object.values(def.columns),keys.map(k=>({id:'i',number:'AB1',status:' 有效 '})[k]??'')]);
 assert.equal(rows[0].status,'有效');
 const caseKeys=Object.keys(schema.collections.cases.columns);
 const cases=parseSheet('cases',[Object.values(schema.collections.cases.columns),caseKeys.map(k=>({id:'c',status:'已成交 ',mode:' 新案'})[k]??'')]);
 assert.equal(cases[0].status,'已成交');
 assert.equal(cases[0].mode,'新案');
});

test('unrecognised invoice or case status is reported instead of silently dropped',()=>{
 const a=run({cases:[{...signedCase,status:'成交'}],invoices:[inv({status:'有效ˊ'})]});
 assert.equal(a.metrics.invoiceCount,0);
 const types=a.issues.filter(i=>i.type==='invalid_value');
 assert.equal(types.length,2);
});

test('quote whose case ID matches no case is reported',()=>{
 const a=run({cases:[signedCase],invoices:[],quotes:[{id:'q',caseId:'typo',date:'2026-06-01',net:500}]});
 assert.equal(a.metrics.quotedCount,0);
 assert.ok(a.issues.some(i=>i.type==='quote_reference'&&i.description.includes('typo')));
});

test('one duplicated invoice number yields one issue per affected row, not three',()=>{
 const a=run({cases:[signedCase],invoices:[inv({}),inv({id:'i2',scheduleId:null})]});
 assert.equal(a.issues.filter(i=>i.type.startsWith('duplicate')).length,2);
});
