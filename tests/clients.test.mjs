import test from 'node:test';
import assert from 'node:assert/strict';
import {clientView} from '../lib/domain/clients.ts';

test('client rows total invoices by year, count a case with its additions once, and flag dormant clients',()=>{
 const clients=[{id:'k1',name:'示範客戶甲'},{id:'k2',name:'示範客戶乙'},{id:'k3',name:'示範客戶丙'}];
 const c=o=>({id:'c',clientId:'k1',stage:'結案',parentId:null,...o});
 const cases=[c({id:'a'}),c({id:'a2',parentId:'a'}),c({id:'b',stage:'報價'}),c({id:'d',clientId:'k2',stage:'開票'}),c({id:'e',clientId:'k3',stage:'未成交'})];
 const inv=(caseId,date,net,o={})=>({caseId,date,net,...o});
 const invoices=[inv('a','2025-03-01',1000),inv('a2','2026-10-01',500),inv('d','2026-02-01',300),inv('zz','2026-01-01',200,{clientId:'k2'})];
 const latest=[{caseIds:['a'],quotes:[{net:1150,feeRate:0.15}]},{caseIds:['b'],quotes:[{net:230,feeRate:0.15}]},{caseIds:['d'],quotes:[{net:300}]}];
 const v=clientView(clients,cases,invoices,latest,'2026-11-16');
 assert.deepEqual(v.rows.map(r=>r.clientId),['k1','k2','k3']);assert.deepEqual(v.years,['2025','2026']);
 const [k1,k2,k3]=v.rows;
 assert.equal(k1.total,1500);assert.deepEqual(k1.byYear,{2025:1000,2026:500});assert.equal(k1.cases,1);assert.equal(k1.average,1500);
 assert.equal(k1.acFee,150);assert.equal(k1.acCases,1);assert.equal(k1.originals,2);assert.equal(k1.won,1);assert.equal(k1.winRate,0.5);
 assert.equal(k1.lastDate,'2026-10-01');assert.equal(k1.dormant,false);assert.equal(k1.activeThisYear,true);
 assert.equal(k2.total,500);assert.equal(k2.cases,1);assert.equal(k2.acFee,null);assert.equal(k2.dormant,true);assert.equal(k2.daysSince,288);
 assert.equal(k3.total,0);assert.equal(k3.lastDate,null);assert.equal(k3.dormant,false);assert.equal(k3.winRate,0);
 assert.equal(v.totals.total,2000);assert.equal(v.totals.active,2);assert.equal(v.totals.dormant,1);assert.equal(v.totals.top3Share,1);
});
