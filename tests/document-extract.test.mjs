import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import schema from '../lib/domain/schema.json' with {type:'json'};

const ctx=vm.createContext({});
vm.runInContext(readFileSync(new URL('../apps-script/document-import.gs',import.meta.url),'utf8'),ctx);
const {extractQuote,extractInvoice,planRecordRows,caseIdsByNumber,buildDigest,digestBody}=ctx;
const plain=v=>JSON.parse(JSON.stringify(v));

// Layouts mirror the real documents; every name and figure here is made up.
const QUOTE=`客戶名稱 示範客戶有限公司 專案編號\n\nA901\n\n項目 內容 單價 數量 單位 金額\n\n10月1日 08:00-17:00 $2,000 10 位 $20,000\n\n⼩計（未稅，未含服務費）\n\n$100,000\n\n服務費(15%)\n\n$15,000\n\n合計（未稅，含服務費）\n\n$115,000\n\n營業稅(5%)\n\n$5,750\n\n$120,750\n\n統⼀編號：00000000\n\n2026 年 05 月 28日／示範製表 總計（含服務費、營業稅）\n\n雙方協議付款日期為 2026 年 09 月 30 日以前。`;
const INVOICE=`電子發票證明聯\n\n2026-04-23 發票號碼：ZZ12345678 格 式：25 買 方：示範客戶有限公司 統一編號：00000000\n\n活動執行 1 4,000 4,000\n\n銷售額合計 4,000 營業人蓋統一發票專用章\n\n營業稅 應稅 √ 零稅率 免稅 200賣 公司 總計 4,200統一編號：00000000 總計新台幣(中文大寫) 肆仟貳佰元整`;

test('quote text yields case number, date, amounts and service-fee rate',()=>{
 assert.deepEqual(plain(extractQuote(QUOTE,'A901 示範活動-報價單V2.pdf')),{caseNumber:'A901',date:'2026-05-28',net:115000,tax:5750,gross:120750,feeRate:0.15,version:'V2',addition:false});
 const none=extractQuote('掃描檔沒有文字','示範活動-報價單(追加).pdf');
 assert.equal(none.net,null);assert.equal(none.feeRate,null);assert.equal(none.date,null);assert.equal(none.caseNumber,'');assert.equal(none.addition,true);
});
test('invoice text yields number, date and amounts; inconsistent totals are left blank',()=>{
 assert.deepEqual(plain(extractInvoice(INVOICE,'A901  ZZ12345678  示範活動(訂金發票).pdf')),{number:'ZZ12345678',caseNumber:'A901',date:'2026-04-23',net:4000,tax:200,gross:4200,type:'訂金'});
 const odd=extractInvoice('銷售額合計 4,000 總計 9,999','A902 YY87654321.pdf');
 assert.equal(odd.number,'YY87654321');assert.equal(odd.net,4000);assert.equal(odd.gross,null);assert.equal(odd.tax,null);
});
test('planned rows follow the sheet headers, link the original case and never duplicate',()=>{
 const caseHead=Object.values(schema.collections.cases.columns),blank=caseHead.map(()=>'');
 const mk=o=>caseHead.map((h,i)=>o[h]??blank[i]);
 const caseIds=plain(caseIdsByNumber([caseHead,mk({案件ID:'add',原案號:'A901',原案ID:'orig'}),mk({案件ID:'orig',原案號:'A901'})]));
 assert.deepEqual(caseIds,{A901:'orig'});
 const qh=Object.values(schema.collections.quotes.columns),ih=Object.values(schema.collections.invoices.columns);
 const docs=[{docId:'doc_aaaa',kind:'報價單',filename:'A901 示範-報價單V2.pdf',fields:extractQuote(QUOTE,'A901 示範-報價單V2.pdf')},{docId:'doc_bbbb',kind:'發票',filename:'A901 ZZ12345678.pdf',fields:extractInvoice(INVOICE,'A901 ZZ12345678 (全款發票).pdf')},{docId:'doc_cccc',kind:'報價單',filename:'空白.pdf',fields:extractQuote('','空白.pdf')}];
 const q=planRecordRows('報價單',qh,[],docs,caseIds);assert.equal(q.length,1);
 const at=(row,head,name)=>row[head.indexOf(name)];
 assert.equal(at(q[0],qh,'報價ID'),'quo_aaaa');assert.equal(at(q[0],qh,'案件ID'),'orig');assert.equal(at(q[0],qh,'未稅金額'),115000);assert.equal(at(q[0],qh,'服務費率'),0.15);assert.equal(at(q[0],qh,'報價日'),'2026-05-28');assert.equal(at(q[0],qh,'來源文件ID'),'doc_aaaa');assert.equal(at(q[0],qh,'有效成交版本'),'');
 const i=planRecordRows('發票',ih,[],docs,caseIds);assert.equal(i.length,1);
 assert.equal(at(i[0],ih,'發票號碼'),'ZZ12345678');assert.equal(at(i[0],ih,'發票狀態'),'待核對');assert.equal(at(i[0],ih,'含稅總額'),4200);assert.equal(at(i[0],ih,'全款訂金尾款追加'),'全款');
 const existing=ih.map(h=>h==='發票號碼'?'ZZ12345678':'');
 assert.equal(planRecordRows('發票',ih,[existing],docs,caseIds).length,0);
 assert.equal(planRecordRows('報價單',qh,[qh.map(h=>h==='來源文件ID'?'doc_aaaa':'')],docs,caseIds).length,0);
 assert.match(at(planRecordRows('報價單',qh,[],docs,{})[0],qh,'備註'),/找不到案號 A901/);
});
test('daily digest lists due follow-ups, activities in the next 7 days and overdue invoices',()=>{
 const ch=['案件ID','原案號','案名','商機狀態','下次追案日','下一步','活動開始日','活動結束日'];
 const cases=[ch,['a','A901','示範甲','已報價待確認','2026-11-10','電話確認','',''],['b','A902','示範乙','已報價待確認','2026-11-30','','',''],['c','A903','示範丙','已成交','2026-11-01','',new Date(2026,10,20),new Date(2026,10,22)],['d','A904','示範丁','未成交','2026-11-01','','2026-11-18','']];
 const ih=['發票號碼','案件ID','開票日','含稅總額','發票狀態','收款到期日','已收款'];
 const invoices=[ih,['ZZ00000001','a','2026-09-01',1050,'有效','',''],['ZZ00000002','a','2026-09-01',2100,'有效','','是'],['ZZ00000003','c','2026-11-10',3150,'有效','',''],['ZZ00000004','c','2026-06-01',4200,'作廢','',''],['ZZ00000005','c','2026-06-01','5,250','有效','2026-12-31','']];
 const d=plain(buildDigest(cases,invoices,'2026-11-16'));
 assert.deepEqual(d.followups.map(f=>f.label),['A901 示範甲']);assert.deepEqual(d.activities,[{label:'A903 示範丙',start:'2026-11-20',end:'2026-11-22'}]);
 assert.deepEqual(d.overdue.map(o=>o.number),['ZZ00000001']);assert.equal(d.overdueTotal,1050);assert.equal(d.overdue[0].due,'2026-10-01');
 const body=digestBody(d,'2026-11-16');assert.match(body,/今天該追】1 案/);assert.match(body,/逾期應收】1 張，合計 NT\$ 1,050/);
 assert.equal(digestBody({followups:[],activities:[],overdue:[],overdueTotal:0},'2026-11-16'),null);
});

test('quote amounts are read when the labels come first and the figures after them',()=>{
 const text='專案編號 A902 報價單 人頭費 200 60 位 12,000 『報價說明』 小計(未稅,未含服務費) 服務費(8%) 合計(未稅,含服務費) 營業稅(5%) 總計(含服務費、營業稅) 100,000 8,000 108,000 5,400 113,400 1. 此為專案價 服務費:7% 2026 年 08月 26 日/示範製表';
 const f=extractQuote(text,'A902 示範-報價單.pdf');
 assert.equal(f.net,108000);assert.equal(f.tax,5400);assert.equal(f.gross,113400);assert.equal(f.feeRate,0.08);assert.equal(f.date,'2026-08-26');
 const bad=extractQuote('合計(未稅,含服務費) 營業稅(5%) 總計(含服務費、營業稅) 100,000 8,000 999 5,400 113,400','x.pdf');
 assert.equal(bad.net,null);assert.equal(bad.gross,null);
});

test('invoice tax and total are found when the total label is separated from its figure',()=>{
 const text='電子發票證明聯 2026-08-08 發票號碼:ZZ00000009 格 式:25 統一編號:00000000 活動執行 1 20,000 20,000 銷售額合計 20,000 營業人蓋統一發票專用章 營業稅 應稅 √ 零稅率 免稅 1,000 賣 方:示範公司 21,000統一編號:00000000 地 址:示範路1段66號5樓 總計 總計新台幣(中文大寫) 貳萬壹仟元整';
 const f=extractInvoice(text,'A903 ZZ00000009 示範(全款發票).pdf');
 assert.equal(f.net,20000);assert.equal(f.tax,1000);assert.equal(f.gross,21000);assert.equal(f.number,'ZZ00000009');
});

test('a quote labelled 發票稅 with decimals is read, and an unreadable quote with a case number still gets a row',()=>{
 const alt=extractQuote('專案編號 A902 合計(未稅，含服務費) $50,000.0 發票稅 $2,499.6 總計(含服務費) $52,500 2026 年 11月 18日/示範製表','A902 示範-報價單.pdf');
 assert.equal(alt.net,50000);assert.equal(alt.tax,2500);assert.equal(alt.gross,52500);assert.equal(alt.date,'2026-11-18');
 const qh=Object.values(schema.collections.quotes.columns),at=(row,name)=>row[qh.indexOf(name)];
 const docs=[{docId:'doc_dddd',kind:'報價單',filename:'A903 掃描-報價單.pdf',fields:extractQuote('掃描檔沒有文字','A903 掃描-報價單.pdf')},{docId:'doc_eeee',kind:'報價單',filename:'沒有案號.pdf',fields:extractQuote('','沒有案號.pdf')},{docId:'doc_ffff',kind:'發票',filename:'A903 空白.pdf',fields:extractInvoice('','A903 空白.pdf')}];
 const rows=planRecordRows('報價單',qh,[],docs,{A903:'case_A903'});
 assert.equal(rows.length,1);assert.equal(at(rows[0],'案件ID'),'case_A903');assert.equal(at(rows[0],'來源文件ID'),'doc_dddd');assert.equal(at(rows[0],'未稅金額'),'');assert.match(at(rows[0],'備註'),/讀不出金額/);
 assert.equal(planRecordRows('發票',Object.values(schema.collections.invoices.columns),[],docs,{}).length,0);
});

// A small stand-in for the Apps Script services, enough to run extractRecords_ end to end.
function fakeBook(sheets){
 const written={};
 const sheet=name=>({getDataRange:()=>({getValues:()=>sheets[name]}),getLastRow:()=>sheets[name].length,
  getRange:(row,col,n,w)=>({setValues:v=>{(written[name]??=[]).push(...v);sheets[name].push(...v);}})});
 return {written,ss:{getSheetByName:n=>sheets[n]?sheet(n):null,toast:()=>{}}};
}
function runExtract(sheets,readText,startTries={}){
 const c=vm.createContext({console:{log(){}}});
 vm.runInContext(readFileSync(new URL('../apps-script/document-import.gs',import.meta.url),'utf8'),c);
 const props={extract_tries:JSON.stringify(startTries)};const saves=[];
 c.PropertiesService={getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperty:(k,v)=>{props[k]=v;saves.push(v);}})};
 c.Drive={};let reads=0;c.pdfText_=id=>{reads++;return readText(id);};
 const book=fakeBook(sheets);c.extractRecords_(book.ss);
 return {reads,saves,tries:JSON.parse(props.extract_tries),written:book.written};
}
const docHeaders=['文件ID','文件類型','原始檔名','文件連結','SHA256','原案號','待核對事項','核對狀態'];
const pendingDoc=i=>[`doc_${i}`,'報價單',`示範${i}.pdf`,`https://drive.google.com/file/d/file${String(i).padStart(10,'0')}/view`,`sha${i}`,'','自動匯入：請確認文件類型與原案號','待核對'];
const books=n=>({'文件':[docHeaders,...Array.from({length:n},(_,i)=>pendingDoc(i))],'報價版本':[schema.collections.quotes.columns?Object.values(schema.collections.quotes.columns):[]],'發票':[Object.values(schema.collections.invoices.columns)],'案件商機':[Object.values(schema.collections.cases.columns)]});

test('a run of unreadable scans stops after 15 tries and each try is saved before the read',()=>{
 const r=runExtract(books(20),()=>{throw new Error('OCR failed');});
 assert.equal(r.reads,15);
 assert.equal(Object.keys(r.tries).length,15);
 assert.ok(r.saves.length>=15,'saved once per try, so a time-out cannot lose the count');
 assert.equal(r.written['報價版本'],undefined);
});

test('the importer writes nothing when 來源文件ID is missing from 報價版本',()=>{
 const b=books(2);b['報價版本'][0]=b['報價版本'][0].map(h=>h==='來源文件ID'?'來源文件':h);
 assert.throws(()=>runExtract(b,()=>'A901 報價'),/來源文件ID/);
});
