import test from 'node:test';
import assert from 'node:assert/strict';
import {receivableView,isCollected} from '../lib/domain/receivables.ts';
import {acFee,acFeeOf} from '../lib/domain/margin.ts';
import {followupView} from '../lib/domain/followups.ts';

const inv=o=>({id:'i',number:'AB1',date:'2026-10-01',gross:1050,balance:null,paid:null,overdue:false,...o});
test('an issued invoice is a receivable for its gross until marked collected',()=>{
 const v=receivableView([inv({}),inv({id:'j',collected:'是'}),inv({id:'k',date:'2026-11-10'}),inv({id:'m',gross:null})],'2026-11-16');
 assert.deepEqual(v.rows.map(r=>r.state),['逾期','已收款','未收','金額待補']);
 assert.equal(v.totals.receivable,2100);assert.equal(v.totals.openCount,3);assert.equal(v.totals.unknown,1);
 assert.equal(v.totals.overdue,1050);assert.equal(v.totals.overdueCount,1);assert.equal(v.totals.collected,1050);
 assert.equal(v.rows[0].ageDays,46);assert.equal(v.rows[0].due,'2026-10-31');assert.equal(v.rows[0].dueAssumed,true);
});
test('an explicit due date wins over the 30-day default, and confirmed receipts reduce the amount',()=>{
 const v=receivableView([inv({dueDate:'2026-12-31'}),inv({id:'p',paid:400}),inv({id:'q',balance:0,paid:1050}),inv({id:'r',balance:250,paid:800})],'2026-11-16');
 assert.equal(v.rows[0].state,'未收');assert.equal(v.rows[0].dueAssumed,false);
 assert.equal(v.rows[1].receivable,650);assert.equal(v.rows[2].state,'已收款');assert.equal(v.rows[3].receivable,250);
});
test('collected flag accepts common spellings only',()=>{
 for(const v of ['是',' 已收款 ','V',true])assert.equal(isCollected(v),true);
 for(const v of ['否','',null,'待確認',false])assert.equal(isCollected(v),false);
});
test('AC fee is the service-fee part of the quote net',()=>{
 assert.equal(acFee({net:506000,feeRate:0.15}),66000);
 assert.equal(acFee({net:506000,feeRate:15}),66000);
 assert.equal(acFee({net:105000,feeRate:0.05,discountNet:0}),5000);
 assert.equal(acFee({net:110000,feeRate:0.15,discountNet:5000}),15000);
 assert.equal(acFee({net:1000}),null);assert.equal(acFee({feeRate:0.15}),null);
 assert.equal(acFeeOf([{net:115,feeRate:0.15},{net:230,feeRate:0.15}]),45);
 assert.equal(acFeeOf([{net:115,feeRate:0.15},{net:230}]),null);assert.equal(acFeeOf([]),null);
});
test('follow-up list covers undecided cases, due ones first, bucketed by quote age',()=>{
 const c=o=>({id:'c',number:'A901',title:'示範',clientId:'k',stage:'報價',...o});
 const cases=[c({id:'a'}),c({id:'b',nextFollowupDate:'2026-11-10',nextAction:'電話確認'}),c({id:'d'}),c({id:'e',stage:'提案'}),c({id:'f',stage:'開票'}),c({id:'g',stage:'未成交'}),c({id:'h',nextFollowupDate:'2026-12-01'})];
 const q=(id,date,net,rate)=>({caseIds:[id],date,net,quotes:[{net,feeRate:rate}]});
 const v=followupView(cases,[q('a','2026-11-01',1150,0.15),q('b','2026-08-01',2000),q('d','2026-01-05',3000),q('h','2026-10-01',500),q('f','2026-11-01',9)],'2026-11-16');
 assert.deepEqual(v.rows.map(r=>r.caseId),['b','a','h','d','e']);
 assert.deepEqual(v.rows.map(r=>r.bucket),['stale','fresh','mid','stale','noquote']);
 assert.equal(v.rows[0].due,true);assert.equal(v.rows[2].due,false);assert.equal(v.rows[1].acFee,150);assert.equal(v.rows[0].acFee,null);
 assert.deepEqual(v.totals.due,{count:1,net:2000});assert.deepEqual(v.totals.stale,{count:2,net:5000});assert.equal(v.totals.all.count,5);
});
