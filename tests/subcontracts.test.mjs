import test from 'node:test';
import assert from 'node:assert/strict';
import {derive} from '../lib/domain/analytics.ts';
import {normalizeMaintenance} from '../lib/domain/maintenance.ts';
import {subcontractView} from '../lib/domain/subcontracts.ts';

const all={start:null,end:null};
const base={clients:[],documents:[],settings:[],receipts:[],quotes:[],
 cases:[{id:'c1',number:'A901',title:'測試活動甲',mode:'歷史',confirmed:true},{id:'c2',number:'A902',title:'測試活動乙',mode:'歷史',confirmed:true}],
 invoices:[{id:'i1',number:'AB00000001',caseId:'c1',status:'有效',date:'2026-06-01',net:100000,tax:5000,gross:105000},{id:'i2',number:'AB00000002',caseId:'c2',status:'有效',date:'2026-08-01',net:80000,tax:4000,gross:84000}],
 subcontracts:[
  {id:'s1',caseId:'c1',vendor:'甲廠商',kind:'發票',date:'2026-09-04',net:30000,tax:1500,gross:31500,status:'有效'},
  {id:'s2',caseId:'c1',vendor:'甲廠商',kind:'報價單',date:'2026-08-20',net:30000,status:'參考'},
  {id:'s3',caseId:'c2',vendor:'乙廠商',kind:'發票',date:'2026-08-31',net:40000,tax:2000,gross:42000,status:'有效'},
  {id:'s4',caseId:'c2',vendor:'丙廠商',kind:'報價單',date:'2026-08-01',net:null,status:'有效'},
  {id:'s5',caseId:'c2',vendor:'乙廠商',kind:'發票',date:'2026-08-31',net:40000,status:'重複'},
 ]};

test('only 有效 rows count as cost; margins need known costs',()=>{
 const data=normalizeMaintenance(base);const a=derive(data,{period:all,today:'2026-11-15'});
 const v=subcontractView(data,a.cases,all);
 assert.equal(v.rows.length,5);
 assert.equal(v.totals.count,3);
 assert.equal(v.totals.costNet,70000);
 assert.equal(v.totals.unknown,1);
 const c1=v.perCase.find(x=>x.caseId==='c1');
 assert.equal(c1.costNet,30000);assert.equal(c1.revenueNet,100000);assert.equal(c1.margin,70000);assert.equal(c1.marginRate,70);
 const c2=v.perCase.find(x=>x.caseId==='c2');
 assert.equal(c2.margin,null,'an unknown cost amount blocks the margin');
});

test('period filter uses the document date',()=>{
 const data=normalizeMaintenance(base);const a=derive(data,{period:all,today:'2026-11-15'});
 const v=subcontractView(data,a.cases,{start:'2026-09-01',end:'2026-09-30'});
 assert.deepEqual(v.rows.map(r=>r.id),['s1']);
});
