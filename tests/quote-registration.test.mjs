// The rows a quote-making flow (works-quote skill, works-quotation register_rows.py, 報價台) appends when signing is
// installed: 報價版本 → 文件 → 簽署 (待寄送 with 版本紀錄). These tests run such rows through the owner's draft menu and the
// hourly import. All data is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import schema from '../lib/domain/schema.json' with {type:'json'};
import {fakeAppsScript} from './helpers/fake-apps-script.mjs';

const quoteHeaders=Object.values(schema.collections.quotes.columns);
const docHeaders=Object.values(schema.collections.documents.columns);
const caseHeaders=Object.values(schema.collections.cases.columns);
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const rowOf=(headers,o)=>{const r=headers.map(()=>'');for(const[h,v]of Object.entries(o)){const i=headers.indexOf(h);assert.ok(i>=0,'no column '+h);r[i]=v;}return r;};

function world(){
 const probe=fakeAppsScript();
 const signHeaders=Object.values(probe.ctx.SIGN_HEADERS);
 const rt=fakeAppsScript({sheets:{
  '簽署':[signHeaders],'簽署事件':[[...probe.ctx.SIGN_EVENT_HEADERS]],'報價版本':[quoteHeaders],'文件':[docHeaders],
  '案件商機':[caseHeaders,rowOf(caseHeaders,{'案件ID':'case_A790','原案號':'A790','商機狀態':'已報價待確認'})],
  '設定':[['鍵','值','說明'],['sign_webapp_url','https://script.google.com/macros/s/X/exec','']],
 }});
 rt.signHeaders=signHeaders;
 return rt;
}

/** What the registrars append, column by column, as the works-quote skill's table says. */
function register(rt,{n,version,groupId='g1',role='原案',gross=315000,caseId='case_A790'}){
 const bytes=Buffer.from('%PDF-1.4 示範品牌 '+version);
 const file=rt.newFile(`A790 示範品牌活動-報價單${version}.pdf`,bytes,rt.folder);
 const docId='doc_'+file.id.slice(0,16), quoteId='quo_'+String(n).padStart(16,'0'), signId='sig_'+String(n).padStart(16,'0');
 rt.book['報價版本'].appendRow(rowOf(quoteHeaders,{'報價ID':quoteId,'案件ID':caseId,'報價日':'2026-11-22','報價名稱':file.name.replace(/\.pdf$/,''),
  '版本':version,'原案互補追加':role,'報價組ID':groupId,'有效成交版本':'否','未稅金額':300000,'稅額':15000,'含稅金額':gross,'來源文件ID':docId,'備註':'Claude 產生'}));
 rt.book['文件'].appendRow(rowOf(docHeaders,{'文件ID':docId,'文件類型':'報價單','原始檔名':file.name,'文件連結':`https://drive.google.com/file/d/${file.id}/view`,
  'SHA256':sha(bytes),'原案號':'A790','核對狀態':'已處理','備註':'Claude 產生並上傳'}));
 const key=role==='互補'?'quote|'+quoteId:caseId+'|'+groupId;
 const record=JSON.stringify({k:key,v:Number(/(\d+)/.exec(version)[1])});
 rt.book['簽署'].appendRow(rowOf(rt.signHeaders,{'簽署ID':signId,'報價ID':quoteId,'案件ID':caseId,'來源文件ID':docId,'收件人姓名':'陳先生',
  '收件人Email':'buyer@example.com','原檔SHA256':sha(bytes),'簽署狀態':'待寄送','版本紀錄':record,'備註':'Claude 登記'}));
 return {file,docId,quoteId,signId,record,bytes};
}
/** A 40x20 noisy grey PNG, long enough to pass the signature check. */
const signaturePng=()=>{
 const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(40,0);ihdr.writeUInt32BE(20,4);ihdr[8]=8;ihdr[9]=0;
 const raw=Buffer.alloc(20*41);let x=7;for(let i=0;i<raw.length;i++){x=(x*1103515245+12345)&0x7fffffff;raw[i]=i%41===0?0:x>>16&0xff;}
 return 'data:image/png;base64,'+Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
};
const signRow=(rt,id)=>{const d=rt.book['簽署'].data;const r=d.find((x,i)=>i>0&&x[0]===id);return Object.fromEntries(d[0].map((h,i)=>[h,r[i]]));};

test('a registered 待寄送 row passes the draft menu: one draft, link sealed, record kept',()=>{
 const rt=world();
 const q=register(rt,{n:1,version:'V1'});
 const plan=rt.ctx.planSendQueue(rt.signHeaders,rt.book['簽署'].data.slice(1),'2026-11-22');
 assert.deepEqual([...plan.send],[0]);
 assert.deepEqual([...plan.invalid],[]);
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,1,'exactly one draft');
 assert.equal(rt.log.sent.length,0,'nothing is mailed');
 assert.equal(rt.log.drafts[0].to,'buyer@example.com');
 const row=signRow(rt,q.signId);
 assert.equal(row['簽署狀態'],'已寄送',row['備註']);
 assert.equal(row['原檔SHA256'],sha(q.bytes));
 assert.match(row['快照雜湊'],/^[0-9a-f]{64}$/);
 assert.equal(row['版本紀錄'],q.record,'the record written at registration is the one the script computes');
 const token=/[?&]t=([0-9a-f]{64})/.exec(rt.log.drafts[0].body)[1];
 assert.equal(rt.ctx.signState_(rt.ss,token).state,'open','the link can be signed');
});

test('the hourly import does not register the uploaded PDF a second time',()=>{
 const rt=world();
 const q=register(rt,{n:1,version:'V1'});
 const docs=rt.book['文件'].data;
 const plan=rt.ctx.planChanges(docs[0],docs.slice(1),[{id:q.file.id,name:q.file.name,url:q.file.getUrl(),folder:'2026報價單',kind:'報價單',sha256:sha(q.bytes)}]);
 assert.equal(plan.append.length,0);
 assert.equal(plan.skipped,1);
});

test('a registered V2 closes V1 at once (the row counts as issued) and gets its own draft',()=>{
 const rt=world();
 register(rt,{n:1,version:'V1'});
 rt.ctx.createSignDrafts();
 const t1=/[?&]t=([0-9a-f]{64})/.exec(rt.log.drafts[0].body)[1];
 register(rt,{n:2,version:'V2'});
 assert.equal(rt.ctx.signState_(rt.ss,t1).state,'voided','V1 is voided as soon as V2 is registered, before its draft exists');
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,2);
 assert.match(rt.log.drafts[1].subject,/更新版/);
 assert.equal(signRow(rt,'sig_'+'1'.padStart(16,'0'))['簽署狀態'],'已作廢');
 assert.equal(signRow(rt,'sig_'+'2'.padStart(16,'0'))['簽署狀態'],'已寄送');
});

test('a 互補 quote is its own group: its version record uses quote|報價ID',()=>{
 const rt=world();
 register(rt,{n:1,version:'V1'});
 const q=register(rt,{n:2,version:'V1',role:'互補'});
 assert.equal(q.record,JSON.stringify({k:'quote|'+q.quoteId,v:1}));
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,2,'both quotes get a draft');
 assert.equal(signRow(rt,q.signId)['簽署狀態'],'已寄送');
});

test('a registration with the wrong case is refused for good: 寄送失敗, reason in 備註, no draft',()=>{
 const rt=world();
 const q=register(rt,{n:1,version:'V1'});
 const r=rt.book['簽署'].data[1];r[rt.signHeaders.indexOf('案件ID')]='case_A791';
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,0);
 const row=signRow(rt,q.signId);
 assert.equal(row['簽署狀態'],'寄送失敗');
 assert.match(row['備註'],/案件/);
});

/** The record the script itself would write for this quote, from 報價版本 as it is now. */
const scriptRecord=(rt,quoteId)=>{const d=rt.book['報價版本'].data,h=d[0];const r=d.find((x,i)=>i>0&&x[h.indexOf('報價ID')]===quoteId);
 return rt.ctx.versionRecordFor(rt.ctx.quoteGroupKeys(h,d.slice(1))[quoteId],rt.ctx.versionNumber(r[h.indexOf('版本')]));};

test('the registered 版本紀錄 is what the script computes, before any draft exists (V0, blank group, 互補, V2)',()=>{
 const rt=world();
 const cases=[register(rt,{n:1,version:'V0'}),register(rt,{n:2,version:'V2',groupId:'',caseId:'case_A790-addition'}),register(rt,{n:3,version:'V1',role:'互補'}),register(rt,{n:4,version:'2026 V3',groupId:'g2'})];
 for(const q of cases)assert.equal(q.record,scriptRecord(rt,q.quoteId),q.quoteId);
});

test('a new case needs its 案件商機 row: without it a draft is made but signing back is refused',()=>{
 const rt=world();
 const q=register(rt,{n:1,version:'V1',caseId:'case_A799'});
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,1,'the draft menu does not look at 案件商機');
 const token=/[?&]t=([0-9a-f]{64})/.exec(rt.log.drafts[0].body)[1];
 rt.ctx.requestSignCode(token);
 const code=/(\d{6})/.exec(rt.log.sent.at(-1).body)[1];
 assert.throws(()=>rt.ctx.submitSignature(token,{name:'王小明',title:'經理',consent:true,image:signaturePng(),agent:'UA',code}),/暫時無法簽回/);
 const ev=rt.book['簽署事件'].data.at(-1);
 assert.equal(ev[2],'簽回失敗');assert.match(ev[6],/找不到案件 case_A799/);
 assert.notEqual(signRow(rt,q.signId)['簽署狀態'],'已簽回');
});
