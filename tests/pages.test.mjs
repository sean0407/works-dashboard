import test from 'node:test';
import assert from 'node:assert/strict';
import schema from '../lib/domain/schema.json' with {type:'json'};
import {loadForAccount} from '../lib/pages/google-sheets.ts';

// Minimal fake Google Sheets API: each source sheet has only its canonical header row.
function fakeSheets({status=200}={}){
 const sheets=Object.fromEntries(schema.sourceCollections.map(k=>{const def=schema.collections[k];return[def.sheet,[Object.values(def.columns)]];}));
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url,auth:init.headers.Authorization});
  if(status!==200)return new Response('{}',{status});
  if(url.includes('?fields='))return Response.json({sheets:Object.keys(sheets).map(title=>({properties:{title,gridProperties:{rowCount:50,columnCount:40}}}))});
  const range=decodeURIComponent(url.split('/values/')[1].split('?')[0]);
  const values=sheets[range.slice(1,range.lastIndexOf("'!"))];
  return Response.json({values:range.endsWith(':A50')?values.map(r=>[r[0]]):values});
 };
 return {fetcher,calls};
}
const target={spreadsheetId:'abcdefghij12345'};

test('a shared account loads data with its own bearer token, no separate allowlist needed',async()=>{
 const {fetcher,calls}=fakeSheets();
 const r=await loadForAccount('tok',target,fetcher);
 assert.equal(r.status,'success');
 assert.ok(calls.every(c=>c.auth==='Bearer tok'));
 assert.ok(calls.every(c=>c.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/abcdefghij12345')));
});

test('an account the sheet is not shared with gets no data',async()=>{
 for(const status of [403,404]){const r=await loadForAccount('tok',target,fakeSheets({status}).fetcher);assert.equal(r.status,'access_denied');assert.equal(r.data,undefined);}
 assert.equal((await loadForAccount('tok',target,fakeSheets({status:401}).fetcher)).status,'reauthentication_required');
});

test('Google error bodies map to the specific fix the visitor needs',async()=>{
 const {googleError}=await import('../lib/pages/google-sheets.ts');
 const body=(status,message,reason)=>({error:{status,message,details:reason?[{reason}]:[]}});
 assert.match(googleError(403,body('PERMISSION_DENIED','Google Sheets API has not been used in project 1 before or it is disabled.','SERVICE_DISABLED')).message,/尚未啟用 Google Sheets API/);
 assert.match(googleError(403,body('PERMISSION_DENIED','Request had insufficient authentication scopes.','ACCESS_TOKEN_SCOPE_INSUFFICIENT')).message,/沒有允許「查看 Google 試算表」/);
 assert.match(googleError(400,body('FAILED_PRECONDITION','This operation is not supported for this document')).message,/不是 Google 試算表格式/);
 assert.match(googleError(403,body('PERMISSION_DENIED','The caller does not have permission')).message,/共用給目前登入的帳號/);
 assert.match(googleError(404,body('NOT_FOUND','Requested entity was not found.')).message,/找不到這份試算表/);
 assert.equal(googleError(401,null).status,'reauthentication_required');
});

