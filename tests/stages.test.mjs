import test from 'node:test';
import assert from 'node:assert/strict';
import {stageSummary} from '../lib/domain/stages.ts';

const c=(id,stage,extra={})=>({id,stage,saleNet:null,parentId:'',...extra});

test('stage counts, shares and amounts',()=>{
 const cases=[c('a','提案'),c('b','報價'),c('d','報價'),c('e','結案',{saleNet:1000}),c('f','結案',{saleNet:500,parentId:'e'})];
 const quotes=[{caseIds:['b'],net:300},{caseIds:['d'],net:null}];
 const [p,q,k]=stageSummary(cases,quotes,['提案','報價','結案']);
 assert.deepEqual([p.count,q.count,k.count],[1,2,1],'additions are not counted as cases');
 assert.equal(q.share,50);
 assert.equal(p.amount,null,'提案 has no amount');
 assert.equal(q.amount,300);assert.equal(q.unknown,1);
 assert.equal(k.amount,1500,'addition amounts roll into the parent stage');
});
