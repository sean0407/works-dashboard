'use client';
import {useState} from 'react';
import {KpiCards} from './kpi-cards';
import {DataTable,type Column} from './data-table';
import {documentCoverage} from '@/lib/domain/coverage';
import {text} from '@/lib/domain/analytics';
type Coverage=ReturnType<typeof documentCoverage>;
export type CoverageFilter='all'|'missing'|'both'|'wonOnly'|'quoteOnly'|'review';
const labels:Record<CoverageFilter,string>={all:'全部案件',missing:'缺報價資料',both:'成交與報價皆有',wonOnly:'成交未列本期報價',quoteOnly:'報價未列本期成交',review:'文件或配對待核對'};
const safe=(value:unknown)=>{try{const url=new URL(text(value));return url.protocol==='https:'?url.href:null;}catch{return null;}};
export function CoverageSummary({coverage,open}:{coverage:Coverage;open:(filter:CoverageFilter)=>void}){
 const s=coverage.summary;const missing=coverage.rows.filter(r=>r.cohort==='wonOnly'&&r.missingQuote).length;
 return <section className="panel coverage-summary" aria-label="成交與報價案件數對照"><div className="panel-heading"><div><h2>案件數為什麼不同？</h2><p>成交按成交認定日；報價按最新版本的報價日。文件是否缺少，另外逐案檢查。</p></div><button className="text-link" onClick={()=>open('all')}>查看完整缺件清單 →</button></div><div className="context-cards"><div><span>成交與本期最新報價皆有</span><strong>{s.matchedWins}<small> 案</small></strong><p>對應 {s.matchedQuotes} 個報價案號；追加併回原案。</p><button className="text-link" onClick={()=>open('both')}>列出案件 →</button></div><div><span>成交，但未列本期最新報價</span><strong>{s.wonOnly}<small> 案</small></strong><p>其中 {missing} 案缺報價；其餘可能在其他期間或屬留存版本。</p><button className="text-link" onClick={()=>open('wonOnly')}>查看差異與缺件 →</button></div><div><span>本期有報價，未列本期成交</span><strong>{s.quoteOnly}<small> 個案號</small></strong><p>可能尚待成交、關聯待核對，或成交日在其他期間。</p><button className="text-link" onClick={()=>open('quoteOnly')}>查看案件與成交日期 →</button></div></div><p className="panel-footnote">同案號報價取最新一組；成交案件依內部原案辨識。原始文件與舊版本保留，不能直接用兩張 KPI 的總件數相減當待成交。</p></section>;
}
export function DocumentCoveragePanel({coverage,filter,setFilter,select}:{coverage:Coverage;filter:CoverageFilter;setFilter:(filter:CoverageFilter)=>void;select:(id:string)=>void}){
 const [query,setQuery]=useState('');
 const match=(r:typeof coverage.rows[number],f:CoverageFilter)=>f==='all'||f==='missing'&&r.missingQuote||f==='review'&&r.needsReview||r.cohort===f;
 const rows=coverage.rows.filter(r=>match(r,filter)&&`${r.number} ${r.title} ${r.clientName} ${r.reasons.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
 type R=typeof rows[number];
 const columns:Column<R>[]=[
  {key:'number',label:'案號',value:r=>r.number,filter:'text',width:'96px',render:r=><span className="case-number">{r.number}</span>},
  {key:'title',label:'案名',value:r=>r.title,filter:'text',render:r=><strong className="cell-strong">{r.title}</strong>},
  {key:'client',label:'付款公司',value:r=>r.clientName,filter:'select'},
  {key:'won',label:'本期成交',value:r=>r.wonInPeriod?'已成交':'未列入',filter:'select'},
  {key:'quoted',label:'本期最新報價',value:r=>r.quotedInPeriod?'有':'未列入',filter:'select'},
  {key:'quotes',label:'報價份數',kind:'num',value:r=>r.quoteCount,filter:'none'},
  {key:'invoices',label:'有效發票',kind:'num',value:r=>r.invoiceCount,filter:'none',render:r=><>{r.invoiceCount}{r.voidInvoiceCount>0&&<small className="muted">另 {r.voidInvoiceCount} 張作廢</small>}</>},
  {key:'reasons',label:'缺件與下一步',value:r=>r.reasons.join('；')||'文件已連結',filter:'text',render:r=>r.reasons.length?<span className="cell-wrap">{r.reasons.map(reason=><small className={reason==='尚無發票，不代表失單或欠款'||reason.includes('其他期間')?'muted':'amber-text'} key={reason}>{reason}</small>)}</span>:<span className="badge green">文件已連結</span>},
  {key:'files',label:'原件',value:r=>r.files.length,filter:'none',kind:'num',render:r=>r.files.length?<details className="coverage-files" onClick={e=>e.stopPropagation()}><summary>{r.files.length} 份</summary>{r.files.map(d=>{const url=safe(d.url);return url?<a key={text(d.id)} href={url} target="_blank" rel="noopener noreferrer">{text(d.filename)} ↗</a>:<span key={text(d.id)}>{text(d.filename)}（連結待補）</span>;})}</details>:<span className="muted">—</span>},
 ];
 return <><section className="panel"><div className="panel-heading"><div><h2>案件文件與缺件清單</h2><p>保留所有歷史報價作為文件證據，較早版本不會被誤判為缺件。</p></div><span className="badge">{rows.length} 案</span></div><KpiCards label="依文件狀態篩選" value={filter} onChange={setFilter} items={(Object.keys(labels) as CoverageFilter[]).map(key=>({key,label:labels[key],value:coverage.rows.filter(r=>match(r,key)).length,unit:'案'}))}/><div className="coverage-filters"><input className="coverage-search" aria-label="搜尋文件缺件" placeholder="搜尋案號、客戶或缺件原因" value={query} onChange={e=>setQuery(e.target.value)}/></div><DataTable rows={rows} columns={columns} rowKey={r=>r.id} onRowClick={r=>select(r.id)} fileName="文件完整性" pageSize={25} empty="這個篩選下沒有案件。"/></section><section className="panel"><div className="panel-heading"><div><h2>其他文件待整理</h2><p>尚未配對到報價／發票紀錄的原件；不受上方案件期間與客戶篩選限制。</p></div><span className="badge">{coverage.unlinkedDocuments.length} 份</span></div><div className="coverage-unlinked">{coverage.unlinkedDocuments.length?coverage.unlinkedDocuments.map(d=><details key={text(d.id)}><summary>{text(d.filename)}</summary><p>{text(d.reviewNotes)||'請確認文件類型與案件，補齊必要欄位。'}</p>{safe(d.url)&&<a className="text-link" href={safe(d.url)!} target="_blank" rel="noopener noreferrer">開啟來源原件 ↗</a>}</details>):<p className="panel-footnote">目前沒有未配對原件。</p>}</div></section></>;
}
