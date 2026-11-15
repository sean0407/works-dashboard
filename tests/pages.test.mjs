import test from 'node:test';
import assert from 'node:assert/strict';
import schema from '../lib/domain/schema.json' with {type:'json'};
import {allowedEmails,checkAllowed,loadForAccount} from '../lib/pages/google-sheets.ts';

const settings=rows=>({settings:rows});

test('allowed_emails parses commas, newlines and case, and fails closed when missing',()=>{
 assert.deepEqual(allowedEmails(settings([{key:'allowed_emails',value:'A@x.com, b@x.com\nc@x.com；a@x.com'}])),['a@x.com','b@x.com','c@x.com']);
 assert.equal(allowedEmails(settings([])),null);
 assert.equal(checkAllowed(settings([]),'a@x.com').ok,false);
 assert.equal(checkAllowed(settings([{key:'allowed_emails',value:''}]),'a@x.com').ok,false);
 assert.equal(checkAllowed(settings([{key:'allowed_emails',value:'a@x.com'}]),'B@x.com').ok,false);
 assert.equal(checkAllowed(settings([{key:'allowed_emails',value:'a@x.com'}]),'A@X.com').ok,true);
});

// Minimal fake Google Sheets API: each source sheet has its canonical header row, settings carries the allowlist.
function fakeSheets(allow,{status=200}={}){
 const sheets=Object.fromEntries(schema.sourceCollections.map(k=>{const def=schema.collections[k];return[def.sheet,[Object.values(def.columns)]];}));
 const settingsDef=schema.collections.settings;
 if(allow!==undefined)sheets[settingsDef.sheet].push(['allowed_emails',allow,'']);
 const calls=[];
 const fetcher=async(url,init)=>{
  calls.push({url,auth:init.headers.Authorization});
  if(status!==200)return new Response('{}',{status});
  if(url.includes('?fields='))return Response.json({sheets:Object.keys(sheets).map(title=>({properties:{title,gridProperties:{rowCount:50,columnCount:40}}}))});
  const range=decodeURIComponent(url.split('/values/')[1].split('?')[0]);
  const title=range.slice(1,range.lastIndexOf("'!"));
  const values=sheets[title];
  return Response.json({values:range.endsWith(':A50')?values.map(r=>[r[0]]):values});
 };
 return {fetcher,calls};
}
const target={spreadsheetId:'abcdefghij12345'};

test('listed account loads data with its own bearer token',async()=>{
 const {fetcher,calls}=fakeSheets('owner@x.com');
 const r=await loadForAccount('tok','owner@x.com',target,fetcher);
 assert.equal(r.status,'success');
 assert.deepEqual(r.allowedEmails,['owner@x.com']);
 assert.ok(calls.every(c=>c.auth==='Bearer tok'));
 assert.ok(calls.every(c=>c.url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/abcdefghij12345')));
});

test('unlisted account or missing list gets no data',async()=>{
 let r=await loadForAccount('tok','stranger@x.com',target,fakeSheets('owner@x.com').fetcher);
 assert.equal(r.status,'access_denied');assert.equal(r.data,undefined);
 r=await loadForAccount('tok','owner@x.com',target,fakeSheets(undefined).fetcher);
 assert.equal(r.status,'access_denied');assert.equal(r.data,undefined);
});

test('Google permission and expiry errors map to clear statuses',async()=>{
 assert.equal((await loadForAccount('tok','owner@x.com',target,fakeSheets('owner@x.com',{status:403}).fetcher)).status,'access_denied');
 assert.equal((await loadForAccount('tok','owner@x.com',target,fakeSheets('owner@x.com',{status:401}).fetcher)).status,'reauthentication_required');
});
