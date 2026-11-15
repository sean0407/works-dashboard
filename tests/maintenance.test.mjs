import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMaintenance} from '../lib/domain/maintenance.ts';
import {derive} from '../lib/domain/analytics.ts';
const base=()=>({clients:[],cases:[{id:'c',mode:'歷史',confirmed:true,reviewNotes:'【金額差異】請核對（來源文件：d）\n自由備註',reviewStatus:'待核對'}],quotes:[],invoices:[{id:'i',number:'AB12345678',caseId:'c',status:'有效',date:'2026-06-01',net:1000,tax:50,gross:1050,receiptVerified:true,scheduleId:'p',expectedGross:1050,plannedDate:'2026-06-01',scheduleConfirmed:true}],receipts:[],documents:[{id:'d'}],settings:[]});
const filters={period:{start:null,end:null},today:'2026-11-15'};
test('one bank entry can have split rows without counting its amount twice',()=>{
 const d=base();d.invoices.push({id:'i2',number:'AB12345679',caseId:'c',status:'有效',gross:500,net:476,tax:24});
 d.receipts=[{id:'r',recordType:'收款',date:'2026-06-02',amount:1550,verified:true,invoiceId:'AB12345678',allocatedAmount:1050},{id:'r',recordType:'分配',allocationId:'a2',invoiceId:'i2',allocatedAmount:500}];
 const n=normalizeMaintenance(d);assert.equal(n.receipts.length,1);assert.equal(n.allocations.length,2);assert.equal(n.allocations[0].invoiceId,'i');assert.equal(n.allocations[0].caseId,'c');
 const a=derive(n,filters);assert.equal(a.metrics.receiptsGross,1550);assert.equal(a.invoices.find(i=>i.id==='i').balance,0);
});
test('duplicate actual bank rows fail rather than silently double count',()=>{
 const d=base();d.receipts=[{id:'r',amount:100,verified:true},{id:'r',amount:100,verified:true}];assert.throws(()=>normalizeMaintenance(d),/收款ID.*重複/);
});
test('planned invoices remain milestones and do not become actual turnover',()=>{
 const d=base();d.invoices.push({id:'draft',caseId:'c',status:'待開票',scheduleId:'p2',expectedGross:200,scheduleConfirmed:true,plannedDate:'2026-12-01'});
 const n=normalizeMaintenance(d);assert.equal(n.invoices.length,1);assert.equal(n.invoiceSchedule.length,2);assert.equal(n.invoiceSchedule[1].invoiceId,null);assert.equal(derive(n,filters).metrics.invoiceGross,1050);
});
test('missing allocation links stay invalid, never guessed as full payment',()=>{
 const d=base();d.receipts=[{id:'r',amount:500,verified:true},{id:'r',recordType:'分配',invoiceId:'unknown',allocatedAmount:600}];
 const n=normalizeMaintenance(d);assert.equal(n.allocations[0].invoiceId,'unknown');assert.equal(derive(n,filters).invoices[0].balance,1050);
});
test('case warning lines preserve evidence and can be resolved in the case row',()=>{
 const d=base();const n=normalizeMaintenance(d);assert.equal(n.reconciliation.length,2);assert.equal(n.reconciliation[0].sourceId,'d');assert.equal(n.reconciliation[0].type,'金額差異');assert.equal(n.quoteItems.length,0);assert.equal(n.tasks.length,0);
 d.cases[0].reviewStatus='已處理';assert.equal(normalizeMaintenance(d).reconciliation.length,0);
});
test('allocation-only lines cannot fabricate another actual receipt or an invoice plan amount',()=>{
 const d=base();d.receipts=[{id:'missing',recordType:'分配',invoiceId:'i',allocatedAmount:1050}];const n=normalizeMaintenance(d);assert.equal(n.receipts.length,0);assert.equal(n.allocations.length,1);assert.equal(derive(n,filters).invoices[0].balance,null);
 assert.equal(n.invoiceSchedule[0].expectedGross,1050);
});
test('document-only budget warnings remain visible without fabricating a case',()=>{
 const d=base();d.documents[0].reviewNotes='【預算非實支】需要核對';d.documents[0].reviewStatus='待核對';
 const warnings=normalizeMaintenance(d).reconciliation;assert.equal(warnings.length,3);assert.equal(warnings[2].caseId,null);assert.equal(warnings[2].sourceId,'d');
 d.documents[0].reviewStatus='已處理';assert.equal(normalizeMaintenance(d).reconciliation.length,2);
});
