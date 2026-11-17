import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import schema from '../lib/domain/schema.json' with {type:'json'};

// Load both Apps Script files into one context, as they share one project.
const ctx=vm.createContext({});
for(const f of ['document-import.gs','quote-signing.gs'])vm.runInContext(readFileSync(new URL(`../apps-script/${f}`,import.meta.url),'utf8'),ctx);
const {SIGN_HEADERS,CASE_SIGN_HEADERS,QUOTE_SIGN_HEADERS,addWorkingDays,isoDay,isEmail,planSendQueue,findSignatureByTokenHash,pageStateFor,planSignedCase,buildSignEmail,escapeHtml}=ctx;

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
 assert.ok(!isEmail('阿哲'));
});

test('send queue: send valid rows, flag invalid ones, void older open links of the same case, expire overdue',()=>{
 const rows=[
  sig({id:'sig_old',caseId:'case_A288',status:'已寄送',dueDate:'2026-12-01'}),
  sig({id:'sig_late',caseId:'case_A200',status:'已檢視',dueDate:'2026-11-10'}),
  sig({id:'sig_fine',caseId:'case_A201',status:'已寄送',dueDate:'2026-12-01'}),
  queued('sig_new','case_A288'),
  queued('sig_bad','case_A202',{recipientEmail:'阿哲'}),
  sig({id:'sig_done',caseId:'case_A288',status:'已簽回'}),
 ];
 const plan=planSendQueue(signHeaders,rows,'2026-11-17');
 assert.deepEqual([...plan.send],[3]);
 assert.deepEqual([...plan.invalid.map(p=>[p.index,p.reason])],[[4,'收件人Email 格式不正確']]);
 assert.deepEqual([...plan.void.map(v=>[v.index,v.by])],[[0,'sig_new']]);
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
});

test('first signature fills the deal fields and marks the case won',()=>{
 const plan=planSignedCase(caseHeaders,caseRow({id:'case_A288',status:'已報價待確認'}),'2026-11-20','doc_signed1');
 assert.deepEqual({...plan.set},{signedSourceId:'doc_signed1',decisionDate:'2026-11-20',status:'已成交'});
 assert.equal(plan.revision,false);
 assert.equal(plan.conflicts.length,0);
});

test('a re-signed revision keeps the original deal date and fills the revision fields',()=>{
 const row=caseRow({id:'case_A280',status:'已成交',signedSourceId:'doc_first',decisionDate:'9/30/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-11-20','doc_second');
 assert.equal(plan.revision,true);
 assert.deepEqual({...plan.set},{revisionSignedDate:'2026-11-20',revisionSignedSourceId:'doc_second'});
});

test('filled cells are never overwritten; differences go to review',()=>{
 const row=caseRow({id:'case_A288',status:'未成交',decisionDate:'11/18/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-11-20','doc_signed1');
 assert.deepEqual({...plan.set},{signedSourceId:'doc_signed1'});
 assert.equal(plan.conflicts.length,2);
 assert.match(plan.conflicts[0],/成交決策日已有「2026-11-18」/);
 assert.match(plan.conflicts[1],/商機狀態為「未成交」/);
});

test('marking the same signed document twice changes nothing',()=>{
 const row=caseRow({id:'case_A288',status:'已成交',signedSourceId:'doc_signed1',decisionDate:'11/20/2026'});
 const plan=planSignedCase(caseHeaders,row,'2026-11-20','doc_signed1');
 assert.equal(plan.revision,false);
 assert.deepEqual({...plan.set},{});
 assert.equal(plan.conflicts.length,0);
});

test('signing e-mail carries the link, amount and due date, and escapes HTML',()=>{
 const m=buildSignEmail({title:'A288 <Logitech>',gross:'3,427,289',recipientName:'阿哲',link:'https://script.google.com/macros/s/X/exec?t=abc',due:'2026-12-01'});
 assert.equal(m.subject,'【沃克思國際有限公司】報價單簽署：A288 <Logitech>');
 assert.match(m.text,/阿哲 您好/);
 assert.match(m.text,/NT\$ 3,427,289/);
 assert.match(m.text,/exec\?t=abc/);
 assert.match(m.html,/A288 &lt;Logitech&gt;/);
 assert.ok(!m.html.includes('<Logitech>'));
 assert.equal(escapeHtml(`"'&`),'&quot;&#39;&amp;');
});
