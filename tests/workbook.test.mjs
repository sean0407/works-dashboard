import test from 'node:test';import assert from 'node:assert/strict';
import schema from '../lib/domain/schema.json' with {type:'json'};
import {parseSheet,extractValues,checkRequest,loadWorkbook} from '../lib/domain/workbook.ts';
const heads=Object.values(schema.collections.cases.columns);
test('reordered or changed headers fail closed instead of mislabeling financial values',()=>{
 assert.throws(()=>parseSheet('cases',[['錯誤欄名']]),/欄位/);
 assert.throws(()=>parseSheet('cases',[[...heads].reverse()]),/欄位/);
});
test('native cells become typed canonical values; blank money stays unknown',()=>{
 const r=Object.keys(schema.collections.cases.columns).map(k=>({id:'c',confirmed:'是',decisionDate:45292,wonNet:''})[k]??'');const a=parseSheet('cases',[heads,r]);assert.equal(a[0].confirmed,true);assert.equal(a[0].decisionDate,'2024-01-01');assert.equal(a[0].wonNet,null);
});
test('structured and JSON text provider payloads parse, malformed success does not become empty data',()=>{
 assert.deepEqual(extractValues({structuredContent:{values:[['a']]},content:[]}),[['a']]);assert.deepEqual(extractValues({content:[{type:'text',text:JSON.stringify({values:[['b']]})}]}),[['b']]);assert.throws(()=>extractValues({content:[{type:'text',text:'unknown'}]}),/格式/);
});
test('only authenticated same-origin POST without caller targets is accepted',()=>{
 assert.equal(checkRequest({method:'POST',origin:'https://private.test',url:'https://private.test/api/data',userId:'u',body:{}}),null);
 for(const change of [{origin:'https://evil.test'},{userId:null},{body:{spreadsheetId:'other'}},{method:'GET'}])assert.notEqual(checkRequest({method:'POST',origin:'https://private.test',url:'https://private.test/api/data',userId:'u',body:{},...change}),null);
});
test('all reads use fixed target and read-only action, appended row pages participate',async()=>{
 let calls=0;const visited=new Set();const invoke=async(connector,action,args)=>{calls++;assert.equal(args.spreadsheet_id,'native_test_id');
  if(action==='get_spreadsheet_metadata')return {status:'success',result:{content:[],structuredContent:{sheets:Object.values(schema.collections).map(d=>({properties:{title:d.sheet,gridProperties:{rowCount:4,columnCount:40}}}))}}};
  visited.add(args.sheet_name);
  assert.equal(action,'get_spreadsheet_range');assert.equal(args.value_render_option,'UNFORMATTED_VALUE');const def=Object.values(schema.collections).find(s=>s.sheet===args.sheet_name);const keys=Object.keys(def.columns);const h=Object.values(def.columns);
  if(args.range==='A1:A4')return {status:'success',result:{content:[],structuredContent:{values:[[h[0]],['row1'],[],['rowAfterGap']]}}};
  const row=id=>keys.map(k=>k==='id'||k==='key'?id:k==='value'?'test':'');return {status:'success',result:{content:[],structuredContent:{values:args.range.startsWith('A1:')?[h,row('row1')]:[[],row('rowAfterGap')]}}};};
 const a=await loadWorkbook(invoke,{spreadsheetId:'native_test_id'},{pageSize:2});assert.equal(a.status,'success');assert.equal(a.data.cases.length,2);assert.equal(a.data.cases[1].id,'rowAfterGap');assert.equal(calls,1+schema.sourceCollections.length*3);assert.deepEqual([...visited].sort(),['客戶','案件商機','報價版本','發票','收款','文件','設定','發包項目'].sort());assert.equal(a.data.quoteItems.length,0);
});
test('provider failures retain diagnostics and block partial workbook success',async()=>{
 const a=await loadWorkbook(async()=>({status:'rate_limited',message:'slow',retryAfterMs:1000,requestId:'req-1'}),{spreadsheetId:'native_test_id'});assert.equal(a.status,'rate_limited');assert.equal(a.retryAfterMs,1000);assert.equal(a.data,undefined);
});
test('missing target is configuration error and makes no call',async()=>{
 const a=await loadWorkbook(()=>{throw Error('must not call');},{});assert.equal(a.status,'configuration_required');
});
test('quoted correction line amounts may be signed while bank allocations cannot',()=>{
 const def=schema.collections.quoteItems,keys=Object.keys(def.columns);const a=parseSheet('quoteItems',[Object.values(def.columns),keys.map(k=>({id:'adjust',amount:-100,quantity:-1})[k]??'')]);assert.equal(a[0].amount,-100);
 const alloc=schema.collections.allocations;assert.throws(()=>parseSheet('allocations',[Object.values(alloc.columns),Object.keys(alloc.columns).map(k=>({id:'a',amount:-100})[k]??'')]),/數字/);
});
test('changed sheet metadata fails before reading a wrong or excessive grid',async()=>{
 const r=await loadWorkbook(async()=>({status:'success',result:{content:[],structuredContent:{sheets:[]}}}),{spreadsheetId:'native_test_id'});assert.equal(r.status,'source_error');assert.match(r.message,/工作表/);
});
