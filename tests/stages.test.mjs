import test from 'node:test';
import assert from 'node:assert/strict';
import {stageSummary} from '../lib/domain/stages.ts';

const c=(id,stage,extra={})=>({id,stage,saleNet:null,parentId:'',...extra});

test('stage counts, shares and amounts',()=>{
 const cases=[c('a','提案'),c('b','報價'),c('d','報價'),c('e','結案',{invoicedGross:1050,invoicedNet:1000}),c('f','結案',{invoicedGross:525,invoicedNet:500,parentId:'e'})];
 const quotes=[{caseIds:['b'],net:300},{caseIds:['d'],net:null}];
 const [p,q,k]=stageSummary(cases,quotes,['提案','報價','結案']);
 assert.deepEqual([p.count,q.count,k.count],[1,2,1],'additions are not counted as cases');
 assert.equal(q.share,50);
 assert.equal(p.amount,null,'提案 has no amount');
 assert.equal(q.amount,300);assert.equal(q.unknown,1);
 assert.equal(k.amount,1500,'addition amounts roll into the parent stage');
});

test('billed stages use the valid-invoice net even without signing evidence, and never borrow the quote',()=>{
 const cases=[c('u','開票',{won:false,saleNet:null,invoicedGross:84000,invoicedNet:80000}),c('m','開票',{invoicedGross:1,invoicedNet:null}),c('s','成交'),c('h','結案')];
 const quotes=[{caseIds:['u'],net:100000},{caseIds:['m'],net:7000},{caseIds:['s'],net:300},{caseIds:['h'],net:900}];
 const [bill,won,closed]=stageSummary(cases,quotes,['開票','成交','結案']);
 assert.equal(bill.amount,80000,'unsigned but invoiced case shows its invoice net, not the 100,000 quote');
 assert.equal(bill.unknown,1,'an invoice with a missing net is 待補, not the quote');
 assert.equal(won.amount,300,'won without an invoice yet falls back to the quote');
 assert.equal(closed.amount,900,'closed by hand without invoices falls back to the quote');
});

test('in billed stages an addition adds only what it has invoiced, and a missing invoice amount marks its root',()=>{
 const cases=[c('root','開票',{invoicedGross:105,invoicedNet:100}),c('addq','報價',{parentId:'root'}),c('r2','開票',{invoicedGross:105,invoicedNet:100}),c('addb','開票',{parentId:'r2',invoicedGross:1,invoicedNet:null})];
 const [bill]=stageSummary(cases,[{caseIds:['addq'],net:70}],['開票']);
 assert.equal(bill.amount,200,'the unbilled addition quote of 70 is not billing');
 assert.equal(bill.unknown,1,'the billed addition with no net marks r2 as 待補');
 assert.equal(bill.count,2);
});
test('a 原案ID that points to no case counts as its own case',()=>{
 const [bill]=stageSummary([c('orphan','開票',{parentId:'missing',invoicedGross:105,invoicedNet:100})],[],['開票']);
 assert.equal(bill.count,1);assert.equal(bill.share,100);assert.equal(bill.amount,100);
});
