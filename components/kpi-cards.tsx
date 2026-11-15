'use client';
import type {ReactNode} from 'react';

export type KpiItem<K extends string>={key:K;label:string;value:ReactNode;unit?:string;prefix?:string;note?:ReactNode};

/** Clickable KPI cards: the selected card turns dark and the table below follows it. */
export function KpiCards<K extends string>({items,value,onChange,label,className=''}:{items:KpiItem<K>[];value:K;onChange:(key:K)=>void;label:string;className?:string}){
 const cols=items.length<=4?`cols-${items.length}`:'cols-auto';
 return <div className={`stage-kpis ${cols} ${className}`} role="group" aria-label={label}>{items.map(k=><button key={k.key} type="button" className={value===k.key?'active':''} aria-pressed={value===k.key} onClick={()=>onChange(k.key)}>
  <span>{k.label}</span>
  <strong>{k.prefix&&<small>{k.prefix} </small>}{k.value}{k.unit&&<small> {k.unit}</small>}</strong>
  {k.note!=null&&<p>{k.note}</p>}
 </button>)}</div>;
}
