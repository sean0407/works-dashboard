// A small in-memory stand-in for the Apps Script services the two .gs files use, so the runtime paths
// (drafts, signing page, submit, menus) can run under node:test. Only what the scripts call is implemented.
import {readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import vm from 'node:vm';

const pad2=(n)=>String(n).padStart(2,'0');

class Blob {
 constructor(bytes,name){this.bytes=Buffer.from(bytes);this.name=name;}
 getBytes(){return [...this.bytes];}
 getName(){return this.name;}
 setName(n){this.name=n;return this;}
 getAs(){return new Blob(this.bytes,this.name);}
}

class Sheet {
 constructor(name,data){this.name=name;this.data=(data||[]).map(r=>[...r]);this.hooks=[];}
 // Real Sheets keep a leading apostrophe as "this is text" and drop it from the value.
 static unquote(v){return typeof v==='string'&&v.startsWith("'")?v.slice(1):v;}
 fire(op,args){for(const h of this.hooks)h(op,args);}
 cell(r,c){while(this.data.length<r)this.data.push([]);const row=this.data[r-1];while(row.length<c)row.push('');return row;}
 getDataRange(){return {getValues:()=>{const w=this.getLastColumn();return this.data.map(r=>{const x=[...r];while(x.length<w)x.push('');return x;});}};}
 getLastRow(){return this.data.length;}
 getLastColumn(){return this.data.reduce((m,r)=>Math.max(m,r.length),0);}
 getRange(r,c,h=1,w=1){
  const self=this;
  const range={
   setValues(v){self.fire('setValues',{r,c,v});for(let i=0;i<h;i++)for(let j=0;j<w;j++)self.cell(r+i,c+j)[c+j-1]=Sheet.unquote(v[i][j]);return range;},
   setValue(v){self.fire('setValue',{r,c,v});self.cell(r,c)[c-1]=Sheet.unquote(v);return range;},
   getValues(){const out=[];for(let i=0;i<h;i++){const row=[];for(let j=0;j<w;j++)row.push((self.data[r-1+i]||[])[c-1+j]??'');out.push(row);}return out;},
   setFontWeight(){return range;},
  };
  return range;
 }
 appendRow(row){this.fire('appendRow',{row});this.data.push(row.map(Sheet.unquote));}
 setFrozenRows(){}
}

export function fakeAppsScript({sheets={},activeUser='owner@example.com',webAppUrl='https://script.google.com/macros/s/X/exec'}={}){
 const log={sent:[],drafts:[],toasts:[],alerts:[],flushes:0};
 const book={};
 for(const[name,data]of Object.entries(sheets))book[name]=new Sheet(name,data);
 const ss={getId:()=>'book_1',getSheetByName:(n)=>book[n]||null,insertSheet:(n)=>(book[n]=new Sheet(n,[])),toast:(...a)=>log.toasts.push(a)};
 const files=new Map();let fileSeq=0;
 const fileHooks=[];
 const makeFolder=(id)=>{const fo={id,createFile(blob){const f=newFile(blob.getName(),blob.bytes,fo);fileHooks.forEach(h=>h('createFile',f));return f;},
  // Drive's "title contains" matches the start of a name, not any substring: model the strict case.
  searchFiles:(q)=>{const m=/title contains "([^"]+)"/.exec(q);return iterator([...files.values()].filter(f=>f.parent===fo&&!f.trashed&&m&&f.name.startsWith(m[1])));}};return fo;};
 const folder=makeFolder('folder_quotes_1');
 const otherFolder=makeFolder('folder_other_1');
 function newFile(name,bytes,parent){
  const id='drivefile'+String(++fileSeq).padStart(6,'0');
  const f={id,name,bytes:Buffer.from(bytes),parent,description:'',trashed:false,
   getId:()=>f.id,getName:()=>f.name,getBlob:()=>new Blob(f.bytes,f.name),getUrl:()=>`https://drive.google.com/file/d/${f.id}/view`,
   getParents(){let done=false;return {hasNext:()=>!done,next:()=>{done=true;return f.parent;}};},
   getDescription:()=>f.description,setDescription(d){fileHooks.forEach(h=>h('setDescription',f));f.description=d;return f;},setTrashed(v){f.trashed=!!v;return f;}};
  files.set(id,f);
  return f;
 }
 const iterator=(list)=>{let i=0;return {hasNext:()=>i<list.length,next:()=>list[i++]};};
 const cache=new Map();
 const props={};
 const triggers=[];let triggerSeq=0;
 const addTrigger=(handler)=>{const t={handler,id:String(++triggerSeq),getHandlerFunction:()=>handler,getUniqueId:()=>t.id};triggers.push(t);return t;};
 const ui={prompts:[],choices:[],ButtonSet:{OK_CANCEL:'OK_CANCEL',YES_NO_CANCEL:'YES_NO_CANCEL'},Button:{OK:'OK',CANCEL:'CANCEL',YES:'YES',NO:'NO'},
  prompt(){const text=ui.prompts.shift();return {getSelectedButton:()=>text==null?'CANCEL':'OK',getResponseText:()=>text??''};},
  alert(...a){if(a.length>1)return ui.choices.shift();log.alerts.push(a[0]);return 'OK';}};
 const env={activeUser};
 const globals={
  console,
  SpreadsheetApp:{getActive:()=>ss,openById:()=>ss,flush(){log.flushes++;},getUi:()=>ui},
  PropertiesService:{getScriptProperties:()=>({getProperty:(k)=>props[k]??null,setProperty:(k,v)=>{props[k]=v;}})},
  CacheService:{getScriptCache:()=>({get:(k)=>cache.has(k)?cache.get(k):null,put:(k,v)=>{cache.set(k,v);},remove:(k)=>{cache.delete(k);}})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  Session:{getActiveUser:()=>({getEmail:()=>env.activeUser}),getEffectiveUser:()=>({getEmail:()=>'owner@example.com'}),getScriptTimeZone:()=>'Asia/Taipei'},
  Utilities:{
   getUuid:()=>randomUUID(),
   DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
   computeDigest:(alg,data)=>[...createHash('sha256').update(typeof data==='string'?Buffer.from(data,'utf8'):Buffer.from(data)).digest()].map(b=>b>127?b-256:b),
   formatDate:(d,tz,fmt)=>{const day=`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;return fmt==='yyyy-MM-dd'?day:`${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;},
   base64Encode:(bytes)=>Buffer.from(bytes).toString('base64'),
   base64Decode:(text)=>[...Buffer.from(String(text),'base64')].map(b=>b>127?b-256:b),
   newBlob:(data,type,name)=>new Blob(Buffer.from(String(data),'utf8'),name),
  },
  DriveApp:{
   getFileById:(id)=>{const f=files.get(id);if(!f)throw new Error('no file '+id);return f;},
   getFolderById:()=>folder,getRootFolder:()=>folder,
   // Drive's "title contains" matches the start of a name, not any substring: model the strict case.
   searchFiles:(q)=>{const m=/title contains "([^"]+)"/.exec(q);return iterator([...files.values()].filter(f=>!f.trashed&&m&&f.name.startsWith(m[1])));},
  },
  GmailApp:{sendEmail:(to,subject,body,options)=>log.sent.push({to,subject,body,options}),createDraft:(to,subject,body,options)=>log.drafts.push({to,subject,body,options})},
  ScriptApp:{getProjectTriggers:()=>[...triggers],deleteTrigger:(t)=>{const i=triggers.indexOf(t);if(i>=0)triggers.splice(i,1);},
   newTrigger:(handler)=>{const chain={timeBased:()=>chain,everyMinutes:()=>chain,everyHours:()=>chain,atHour:()=>chain,everyDays:()=>chain,create:()=>addTrigger(handler)};return chain;},
   getService:()=>({getUrl:()=>webAppUrl})},
  HtmlService:{createHtmlOutput:(html)=>{const o={html,setTitle:()=>o,addMetaTag:()=>o};return o;}},
 };
 const ctx=vm.createContext(globals);
 for(const f of ['document-import.gs','quote-signing.gs'])vm.runInContext(readFileSync(new URL(`../../apps-script/${f}`,import.meta.url),'utf8'),ctx);
 return {ctx,ss,book,log,files,folder,otherFolder,newFile,cache,props,triggers,addTrigger,ui,env,fileHooks};
}
