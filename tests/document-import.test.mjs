import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import schema from '../lib/domain/schema.json' with {type:'json'};

// Load the Apps Script file as-is; only its pure functions are exercised here.
const ctx=vm.createContext({});
vm.runInContext(readFileSync(new URL('../apps-script/document-import.gs',import.meta.url),'utf8'),ctx);
const {guessKind,guessCaseNumber,docIdFor,driveFileIdFromUrl,planChanges,folderIdFrom,foldersFromSettings,HEADERS}=ctx;

const headers=Object.values(schema.collections.documents.columns);
const blank=()=>headers.map(()=>'');
const at=(row,name)=>row[headers.indexOf(name)];
const file=(id,name,folder='')=>({id,name,folder,url:`https://drive.google.com/file/d/${id}/view`,sha256:`sha-${id}`});

test('script headers match the dashboard schema for 文件',()=>{
 for(const h of Object.values(HEADERS))assert.ok(headers.includes(h),h);
 assert.equal(ctx.DOC_SHEET,schema.collections.documents.sheet);
 assert.equal(ctx.SETTINGS_SHEET,schema.collections.settings.sheet);
});

test('kind and case number are guessed from file and folder names',()=>{
 assert.equal(guessKind('A780 活動報價單 V2.pdf'),'報價單');
 assert.equal(guessKind('Quotation_final.pdf'),'報價單');
 assert.equal(guessKind('AB12345678.pdf'),'發票');
 assert.equal(guessKind('scan001.pdf','發票'),'發票');
 assert.equal(guessKind('合約.pdf','雜項'),'其他');
 assert.equal(guessCaseNumber('A780 活動報價單.pdf'),'A780');
 assert.equal(guessCaseNumber('報價_A076_v1.pdf'),'A076');
 assert.equal(guessCaseNumber('QA12345678.pdf'),'','an invoice number is not a case number');
 assert.equal(guessCaseNumber('scan.pdf','A791 春季活動'),'A791');
 assert.equal(guessCaseNumber('A7801.pdf'),'');
});

test('document ID is stable per Drive file',()=>{
 assert.equal(docIdFor('1AbCdEfGhIjKlMnOpQrStUv'),'doc_1AbCdEfGhIjKlMnO');
 assert.equal(docIdFor('1AbCdEfGhIjKlMnOpQrStUv'),docIdFor('1AbCdEfGhIjKlMnOpQrStUv'));
 assert.equal(driveFileIdFromUrl('https://drive.google.com/file/d/1AbCdEfGhIjK/view?usp=sharing'),'1AbCdEfGhIjK');
 assert.equal(driveFileIdFromUrl('https://drive.google.com/open?id=1AbCdEfGhIjK'),'1AbCdEfGhIjK');
 assert.equal(folderIdFrom('https://drive.google.com/drive/folders/15C41kxTdWJ1WWjv?usp=x'),'15C41kxTdWJ1WWjv');
 assert.equal(folderIdFrom(' 15C41kxTdWJ1WWjv '),'15C41kxTdWJ1WWjv');
});

test('new files become review rows; linked files are skipped',()=>{
 const linked=blank();linked[headers.indexOf('文件連結')]='https://drive.google.com/file/d/fileAAAAAAAAAA/view';
 const plan=planChanges(headers,[linked],[file('fileAAAAAAAAAA','old.pdf'),file('fileBBBBBBBBBB','A791 報價單.pdf'),file('fileBBBBBBBBBB','A791 報價單.pdf')]);
 assert.equal(plan.skipped,2);
 assert.equal(plan.update.length,0);
 assert.equal(plan.append.length,1);
 const row=plan.append[0];
 assert.equal(at(row,'文件ID'),'doc_fileBBBBBBBBBB');
 assert.equal(at(row,'文件類型'),'報價單');
 assert.equal(at(row,'原案號'),'A791');
 assert.equal(at(row,'SHA256'),'sha-fileBBBBBBBBBB');
 assert.equal(at(row,'核對狀態'),'待核對');
 assert.match(at(row,'待核對事項'),/自動匯入/);
 assert.equal(at(row,'備註'),'');
});

test('an existing row with the same file name and no link gets the link, not a duplicate',()=>{
 const old=blank();old[headers.indexOf('文件ID')]='doc_legacy';old[headers.indexOf('原始檔名')]='A776 報價單.pdf';old[headers.indexOf('文件類型')]='報價單';old[headers.indexOf('備註')]='手動登記';
 const plan=planChanges(headers,[blank(),old],[file('fileCCCCCCCCCC','A776 報價單.pdf')]);
 assert.equal(plan.append.length,0);
 assert.equal(plan.update.length,1);
 assert.equal(plan.update[0].row,3,'sheet row number = data index + 2');
 const v=plan.update[0].values;
 assert.equal(at(v,'文件ID'),'doc_legacy','keeps the existing ID');
 assert.equal(at(v,'備註'),'手動登記','keeps filled cells');
 assert.match(at(v,'文件連結'),/fileCCCCCCCCCC/);
 assert.equal(at(v,'原案號'),'A776','fills only blank cells');
});

test('headers are matched by name, so reordered columns still line up',()=>{
 const reordered=[...headers].reverse();
 const plan=planChanges(reordered,[],[file('fileDDDDDDDDDD','AB12345678.pdf')]);
 const row=plan.append[0];
 assert.equal(row[reordered.indexOf('文件類型')],'發票');
 assert.equal(row[reordered.indexOf('文件ID')],'doc_fileDDDDDDDDDD');
 assert.throws(()=>planChanges(headers.filter(h=>h!=='文件連結'),[],[]),/文件連結/);
});

test('quote and invoice folders fix the document kind regardless of file name',()=>{
 const plan=planChanges(headers,[],[{...file('fileEEEEEEEEEE','scan_0012.pdf','2025'),kind:'發票'},{...file('fileFFFFFFFFFF','A783 2026 活動.pdf','2026'),kind:'報價單'}]);
 assert.equal(at(plan.append[0],'文件類型'),'發票');
 assert.equal(at(plan.append[1],'文件類型'),'報價單');
 assert.equal(at(plan.append[1],'原案號'),'A783');
});

test('folders are read from the 設定 sheet with their kinds',()=>{
 const values=[['設定項目','設定值','說明'],['timezone','Asia/Taipei',''],
  ['quotes_folder_id','https://drive.google.com/drive/u/0/folders/1QuotesFolderExampleId000000000',''],
  ['invoices_folder_id','https://drive.google.com/drive/u/0/folders/1InvoicesFolderExampleId00000000','']];
 assert.deepEqual(JSON.parse(JSON.stringify(foldersFromSettings(values))),[{id:'1QuotesFolderExampleId000000000',kind:'報價單'},{id:'1InvoicesFolderExampleId00000000',kind:'發票'}]);
 assert.equal(foldersFromSettings([['設定項目','設定值']]).length,0);
});

test('a second copy of an already registered file (same content hash) is skipped',()=>{
 const known=blank();known[headers.indexOf('文件ID')]='doc_old';known[headers.indexOf('SHA256')]='sha-fileEEEEEEEEEE';known[headers.indexOf('文件連結')]='https://drive.google.com/file/d/otherFileId0001/view';
 const twin={...file('fileFFFFFFFFFF','A901 副本.pdf'),sha256:'sha-fileEEEEEEEEEE'};
 const plan=planChanges(headers,[known],[twin,file('fileGGGGGGGGGG','A902 新檔.pdf'),{...file('fileHHHHHHHHHH','A902 新檔 (1).pdf'),sha256:'sha-fileGGGGGGGGGG'}]);
 assert.equal(plan.append.length,1);assert.equal(at(plan.append[0],'原始檔名'),'A902 新檔.pdf');assert.equal(plan.duplicates,2);
});
