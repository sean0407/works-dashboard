/** Table helpers shared by the dashboard tables; no React so they can be unit-tested. */
export type Cell=string|number|null|undefined;
export type Sort={key:string;dir:'asc'|'desc'}|null;
export type TableColumn<T>={
 key:string;
 label:string;
 /** text: left · num: right with tabular figures · date: left, fixed width */
 kind?:'text'|'num'|'date';
 /** Value used for sorting, filtering and the Excel export. */
 value:(row:T)=>Cell;
 /** select: dropdown of distinct values · text: contains search · none: no filter */
 filter?:'text'|'select'|'none';
 width?:string;
};

export function applyFilters<T>(rows:T[],columns:TableColumn<T>[],filters:Record<string,string>,sort:Sort):T[]{
 const active=Object.entries(filters).filter(([,v])=>v!=='');
 let out=rows.filter(r=>active.every(([key,needle])=>{
  const col=columns.find(c=>c.key===key);if(!col)return true;
  const v=col.value(r);const s=v==null?'':String(v);
  return col.filter==='select'?s===needle:s.toLowerCase().includes(needle.toLowerCase());
 }));
 if(sort){
  const col=columns.find(c=>c.key===sort.key);
  if(col){
   const k=(r:T)=>col.value(r);
   out=[...out].sort((a,b)=>{
    const x=k(a),y=k(b);
    if(x==null||x==='')return y==null||y===''?0:1; // blanks always last
    if(y==null||y==='')return -1;
    const c=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),'zh-Hant',{numeric:true});
    return sort.dir==='asc'?c:-c;
   });
  }
 }
 return out;
}
export function toSheet<T>(rows:T[],columns:TableColumn<T>[]){
 return [columns.map(c=>({value:c.label,fontWeight:'bold' as const})),...rows.map(r=>columns.map(c=>{const v=c.value(r);return v==null||v===''?null:typeof v==='number'?{value:v,type:Number,format:'#,##0'}:{value:String(v),type:String};}))];
}

