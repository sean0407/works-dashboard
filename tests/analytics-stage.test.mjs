import test from 'node:test';
import assert from 'node:assert/strict';
import {derive,CASE_STAGES} from '../lib/domain/analytics.ts';
import {normalizeMaintenance} from '../lib/domain/maintenance.ts';

const all={period:{start:null,end:null},today:'2026-11-15'};
const signed={mode:'新案',confirmed:true,signedSourceId:'d1',decisionDate:'2026-06-01',expectedInvoiceGross:1050};
const inv=(id,caseId,gross,o={})=>({id,number:'AB'+id.padStart(8,'0'),caseId,status:'有效',date:'2026-06-02',net:gross/1.05,tax:gross-gross/1.05,gross,...o});
const stageOf=(cases,{quotes=[],invoices=[]}={})=>{
 const a=derive(normalizeMaintenance({clients:[],documents:[{id:'d1'}],settings:[],receipts:[],cases,quotes,invoices}),all);
 return Object.fromEntries(a.cases.map(c=>[c.id,c]));
};

test('stages are ordered 提案 → 報價 → 成交 → 開票 → 結案',()=>{assert.deepEqual([...CASE_STAGES],['提案','報價','成交','開票','結案']);});

test('each case lands on the stage its evidence supports',()=>{
 const c=stageOf([
  {id:'idea',status:'需求接洽',mode:'新案',confirmed:true},
  {id:'quoted',status:'準備報價',mode:'新案',confirmed:true},
  {id:'pendingStatus',status:'已報價待確認',mode:'新案',confirmed:true},
  {id:'won',status:'已成交',...signed},
  {id:'partial',status:'已成交',...signed},
  {id:'full',status:'已成交',...signed},
  {id:'closed',status:'已成交',closureStatus:'已結案',...signed},
  {id:'lost',status:'未成交',mode:'新案',confirmed:true},
  {id:'cancelLost',status:'取消',mode:'新案',confirmed:true,closureStatus:'已結案'},
 ],{quotes:[{id:'q',caseId:'quoted',date:'2026-05-01',net:100}],invoices:[inv('1','partial',500),inv('2','full',1050),inv('3','closed',1050)]});
 assert.equal(c.idea.stage,'提案');
 assert.equal(c.quoted.stage,'報價');
 assert.equal(c.pendingStatus.stage,'報價');
 assert.equal(c.won.stage,'成交');
 assert.equal(c.partial.stage,'開票');assert.equal(c.partial.invoicedGross,500);
 assert.equal(c.full.stage,'開票','fully invoiced stays 開票 until 結案狀態 is set manually');
 assert.equal(c.closed.stage,'結案');
 assert.equal(c.lost.stage,'未成交');
 assert.equal(c.cancelLost.stage,'未成交','lost wins over a stray 已結案');
});

test('已成交 without signing evidence shows 成交 with a review flag',()=>{
 const c=stageOf([{id:'x',status:'已成交',mode:'新案',confirmed:true}]);
 assert.equal(c.x.stage,'成交');
 assert.equal(c.x.stageFlag,'成交依據待核對');
 assert.equal(c.x.won,false);
});

test('historical case with invoices is 開票, and 結案 only when marked',()=>{
 const c=stageOf([{id:'h',mode:'歷史',confirmed:true},{id:'hc',mode:'歷史',confirmed:true,closureStatus:'已結案'}],{invoices:[inv('4','h',100),inv('5','hc',100)]});
 assert.equal(c.h.stage,'開票');
 assert.equal(c.hc.stage,'結案');
});

test('addition cases get their own stage',()=>{
 const c=stageOf([{id:'p',status:'已成交',...signed},{id:'add',parentId:'p',status:'準備報價',mode:'新案',confirmed:true}],{quotes:[{id:'qa',caseId:'add',date:'2026-07-01',net:10}]});
 assert.equal(c.add.stage,'報價');
 assert.equal(c.p.stage,'成交');
});

test('payment types summarise the case invoices in billing order',()=>{
 const c=stageOf([{id:'p',status:'已成交',...signed},{id:'f',status:'已成交',...signed},{id:'none',status:'準備報價',mode:'新案',confirmed:true}],{invoices:[inv('11','p',300,{type:'尾款'}),inv('12','p',200,{type:'訂金'}),inv('13','p',50,{type:'追加'}),inv('14','f',1050,{type:'全款'}),inv('15','f',10,{type:'訂金',status:'作廢'})]});
 assert.equal(c.p.paymentTypes,'訂金＋尾款＋追加');
 assert.equal(c.f.paymentTypes,'全款','voided invoices do not count');
 assert.equal(c.none.paymentTypes,'');
});

test('each case carries its valid-invoice net, signed or not, and null when a net is missing',()=>{
 const s=stageOf([{id:'u',mode:'新案',confirmed:true},{id:'m',mode:'新案',confirmed:true}],{invoices:[inv('1','u',1050),inv('2','m',525,{net:null})]});
 assert.equal(s.u.won,false);assert.equal(Math.round(s.u.invoicedNet),1000);assert.equal(s.m.invoicedNet,null);
});
