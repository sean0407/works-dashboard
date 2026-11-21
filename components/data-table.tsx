'use client';
import {useEffect,useMemo,useState,type ReactNode} from 'react';
import {ArrowDown,ArrowUp,ArrowUpDown,Download,X} from 'lucide-react';
import {applyFilters,rowsSignature,toSheet,type Cell,type Sort,type TableColumn} from '@/lib/table';

export type {Cell};
export type Column<T>=TableColumn<T>&{
 /** Optional rich cell; falls back to the formatted value. */
 render?:(row:T)=>ReactNode;
};

const fmtNum=(v:number)=>Math.round(v).toLocaleString('zh-TW');
const show=(v:Cell)=>v==null||v===''?'—':typeof v==='number'?fmtNum(v):String(v);

export function DataTable<T>({rows,columns,rowKey,onRowClick,fileName,pageSize=50,empty='沒有符合條件的資料',toolbar}:{rows:T[];columns:Column<T>[];rowKey:(row:T)=>string;onRowClick?:(row:T)=>void;fileName:string;pageSize?:number;empty?:string;toolbar?:ReactNode}){
 const [filters,setFilters]=useState<Record<string,string>>({});
 const [sort,setSort]=useState<Sort>(null);
 const [page,setPage]=useState(0);
 const [busy,setBusy]=useState(false);
 const view=useMemo(()=>applyFilters(rows,columns,filters,sort),[rows,columns,filters,sort]);
 // Back to page 1 only when the rows really change: opening a case re-renders the page with an equal, rebuilt list.
 const signature=useMemo(()=>rowsSignature(rows,rowKey),[rows,rowKey]);
 useEffect(()=>setPage(0),[filters,sort,signature]);
 const pages=Math.max(1,Math.ceil(view.length/pageSize)),current=Math.min(page,pages-1);
 const options=useMemo(()=>Object.fromEntries(columns.filter(c=>c.filter==='select').map(c=>[c.key,[...new Set(rows.map(r=>c.value(r)).filter(v=>v!=null&&v!=='').map(String))].sort((a,b)=>a.localeCompare(b,'zh-Hant',{numeric:true}))])),[rows,columns]);
 const cycle=(key:string)=>setSort(s=>!s||s.key!==key?{key,dir:'asc'}:s.dir==='asc'?{key,dir:'desc'}:null);
 const activeCount=Object.values(filters).filter(Boolean).length;
 async function download(){
  setBusy(true);
  try{
   const {default:writeXlsxFile}=await import('write-excel-file/browser');
   await writeXlsxFile(toSheet(view,columns) as never,{columns:columns.map(c=>({width:c.kind==='num'?14:c.kind==='date'?12:Math.min(48,Math.max(12,c.label.length*2+6))})),stickyRowsCount:1} as never).toFile(`${fileName}-${new Date().toISOString().slice(0,10)}.xlsx`);
  }finally{setBusy(false);}
 }
 const align=(c:Column<T>)=>c.kind==='num'?'num':c.kind==='date'?'date':'';
 return <div className="dt">
  <div className="dt-toolbar">
   <span className="dt-count">{view.length===rows.length?`${rows.length} 筆`:`${view.length} / ${rows.length} 筆`}</span>
   {activeCount>0&&<button className="dt-clear" onClick={()=>setFilters({})}><X size={13}/>清除 {activeCount} 個篩選</button>}
   {toolbar}
   <button className="dt-download" onClick={download} disabled={busy||!view.length} title="下載目前篩選與排序後的資料"><Download size={14}/>{busy?'產生中…':'下載 Excel'}</button>
  </div>
  <div className="table-wrap"><table className="dt-table">
   <thead>
    <tr>{columns.map(c=><th key={c.key} className={align(c)} style={c.width?{width:c.width}:undefined} aria-sort={sort?.key===c.key?(sort.dir==='asc'?'ascending':'descending'):'none'}>
     <button className="dt-sort" onClick={()=>cycle(c.key)}>{c.label}{sort?.key===c.key?(sort.dir==='asc'?<ArrowUp size={12}/>:<ArrowDown size={12}/>):<ArrowUpDown size={12} className="dt-sort-idle"/>}</button>
    </th>)}</tr>
    <tr className="dt-filters">{columns.map(c=><th key={c.key} className={align(c)}>
     {c.filter==='none'?null:c.filter==='select'?
      <select aria-label={`篩選${c.label}`} value={filters[c.key]??''} onChange={e=>setFilters(f=>({...f,[c.key]:e.target.value}))}><option value="">全部</option>{(options[c.key]??[]).map(o=><option key={o} value={o}>{o}</option>)}</select>:
      <input aria-label={`篩選${c.label}`} placeholder="篩選" value={filters[c.key]??''} onChange={e=>setFilters(f=>({...f,[c.key]:e.target.value}))}/>}
    </th>)}</tr>
   </thead>
   <tbody>{view.slice(current*pageSize,(current+1)*pageSize).map(r=><tr key={rowKey(r)} onClick={onRowClick?()=>onRowClick(r):undefined} className={onRowClick?'clickable':undefined} tabIndex={onRowClick?0:undefined} onKeyDown={onRowClick?e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();onRowClick(r);}}:undefined}>
    {columns.map(c=><td key={c.key} className={align(c)}>{c.render?c.render(r):show(c.value(r))}</td>)}
   </tr>)}</tbody>
  </table></div>
  {!view.length&&<p className="dt-empty">{empty}</p>}
  {pages>1&&<div className="dt-pages"><button className="button secondary" disabled={!current} onClick={()=>setPage(current-1)}>上一頁</button><span>{current+1}／{pages} 頁 · 每頁 {pageSize} 筆</span><button className="button secondary" disabled={current>=pages-1} onClick={()=>setPage(current+1)}>下一頁</button></div>}
 </div>;
}
