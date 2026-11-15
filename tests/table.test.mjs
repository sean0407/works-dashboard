import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFilters,toSheet} from '../lib/table.ts';

const rows=[{n:'A010',c:'甲',v:300},{n:'A002',c:'乙',v:null},{n:'A100',c:'甲',v:50},{n:'A020',c:'丙',v:1200}];
const cols=[{key:'n',label:'案號',value:r=>r.n,filter:'text'},{key:'c',label:'客戶',value:r=>r.c,filter:'select'},{key:'v',label:'金額',kind:'num',value:r=>r.v,filter:'none'}];

test('text filter is a case-insensitive contains, select filter is exact',()=>{
 assert.deepEqual(applyFilters(rows,cols,{n:'a0'},null).map(r=>r.n),['A010','A002','A020']);
 assert.deepEqual(applyFilters(rows,cols,{c:'甲'},null).map(r=>r.n),['A010','A100']);
 assert.deepEqual(applyFilters(rows,cols,{c:'甲',n:'100'},null).map(r=>r.n),['A100']);
 assert.equal(applyFilters(rows,cols,{c:''},null).length,4,'empty filter is ignored');
});

test('numbers sort numerically, text naturally, blanks always last',()=>{
 assert.deepEqual(applyFilters(rows,cols,{},{key:'v',dir:'asc'}).map(r=>r.v),[50,300,1200,null]);
 assert.deepEqual(applyFilters(rows,cols,{},{key:'v',dir:'desc'}).map(r=>r.v),[1200,300,50,null]);
 assert.deepEqual(applyFilters(rows,cols,{},{key:'n',dir:'asc'}).map(r=>r.n),['A002','A010','A020','A100']);
 assert.deepEqual(rows.map(r=>r.n),['A010','A002','A100','A020'],'input is not mutated');
});

test('Excel sheet has a bold header row and typed cells',()=>{
 const sheet=toSheet(rows.slice(0,2),cols);
 assert.deepEqual(sheet[0].map(c=>c.value),['案號','客戶','金額']);
 assert.equal(sheet[0][0].fontWeight,'bold');
 assert.deepEqual(sheet[1][2],{value:300,type:Number,format:'#,##0'});
 assert.equal(sheet[2][2],null,'unknown amounts stay blank, not 0');
});
