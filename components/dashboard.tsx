'use client';
import {Fragment,useCallback,useDeferredValue,useEffect,useMemo,useRef,useState} from 'react';
import {Handshake,LayoutDashboard,FileText,Wallet,FolderOpen,CalendarDays,ArrowUpRight,ChevronRight,RefreshCw,Search,SlidersHorizontal,X,ShieldCheck,Check,AlertCircle,ArrowRight,Clock3,Menu,ListChecks,Database,Layers,Info,BellRing,Users} from 'lucide-react';
import {CASE_STAGES,type CaseStage,derive,makePeriod,periodYears,taipeiToday,applyRefresh,compare,inPeriod,money,yes,text,parseDate,type Dataset,type DerivedCase} from '@/lib/domain/analytics';
import {documentCoverage} from '@/lib/domain/coverage';
import {subcontractView,type CaseCost} from '@/lib/domain/subcontracts';
import {stageSummary} from '@/lib/domain/stages';
import {receivableView,DEFAULT_TERM_DAYS,type Receivable} from '@/lib/domain/receivables';
import {acFee,acFeeOf} from '@/lib/domain/margin';
import {followupView,type FollowRow} from '@/lib/domain/followups';
import {activityView,type ActivityRow} from '@/lib/domain/calendar';
import {clientView,DORMANT_DAYS,type ClientRow} from '@/lib/domain/clients';
import {CoverageSummary,DocumentCoveragePanel,type CoverageFilter} from './document-coverage';
import {DataTable,type Column} from './data-table';
import {PERCENT,percentOf} from '@/lib/table';
import {KpiCards} from './kpi-cards';
type Analysis=ReturnType<typeof derive>;
type ProjectFilter=CaseStage|'all'|'invoiced';
type QuoteView='all'|'pending'|'latest'|'ac';
type FollowView='all'|'due'|'fresh'|'mid'|'stale';
type ChartMetric='sales'|'quoted'|'invoiced'|'pending';
type Tab='overview'|'calendar'|'clients'|'quotes'|'followups'|'finance'|'subcontracts'|'projects'|'review'|'coverage';
export type DashboardAccount={email:string;spreadsheetUrl:string;onSignOut:()=>void};
const tabs:{key:Tab;label:string;en:string;icon:typeof LayoutDashboard;group:string}[]=[{key:'overview',label:'營運總覽',en:'OVERVIEW',icon:LayoutDashboard,group:'經營'},{key:'calendar',label:'活動行事曆',en:'ACTIVITIES',icon:CalendarDays,group:'經營'},{key:'followups',label:'追案提醒',en:'FOLLOW-UPS',icon:BellRing,group:'經營'},{key:'quotes',label:'報價管理',en:'QUOTATIONS',icon:FileText,group:'經營'},{key:'projects',label:'案件進度',en:'PROJECTS',icon:FolderOpen,group:'經營'},{key:'finance',label:'財務概況',en:'FINANCE',icon:Wallet,group:'經營'},{key:'clients',label:'客戶分析',en:'CLIENTS',icon:Users,group:'經營'},{key:'subcontracts',label:'發包項目',en:'SUBCONTRACTS',icon:Handshake,group:'資料維護'},{key:'coverage',label:'文件完整性',en:'DOCUMENT COVERAGE',icon:Layers,group:'資料維護'},{key:'review',label:'資料待核對',en:'RECONCILIATION',icon:ListChecks,group:'資料維護'}];
/** 「NT$ 已知金額」 plus 「· N 筆待補」 when some amounts are missing. */
const knownNote=(net:number|null|undefined,unknown:number,unit='筆')=>`${unknown?'已知 ':''}NT$ ${fmt(net??0)}${unknown?` · ${unknown} ${unit}金額待補`:''}`;
const fmt=(value:number|null|undefined)=>value==null?'—':Math.round(value).toLocaleString('zh-TW');
const compact=(v:number)=>Math.abs(v)>=10000?`${(v/10000).toFixed(Math.abs(v)>=1000000?0:1)}萬`:fmt(v);
const dateLabel=(v:unknown)=>parseDate(v)?.replaceAll('-',' / ')??'尚未填寫';
const safeUrl=(value:unknown)=>{try{const u=new URL(text(value));return u.protocol==='https:'?u.href:null;}catch{return null;}};
function Badge({children,tone='neutral'}:{children:React.ReactNode;tone?:string}){return <span className={`badge ${tone}`}>{children}</span>;}
function Empty({title='這裡還沒有資料',description='調整篩選，或前往資料表補上紀錄。'}:{title?:string;description?:string}){return <div className="empty"><span className="empty-icon"><FolderOpen size={23}/></span><strong>{title}</strong><p>{description}</p></div>;}
function PanelTitle({title,sub,action}:{title:string;sub?:string;action?:React.ReactNode}){return <div className="panel-heading"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div>{action}</div>;}
function SourceLink({url,children}:{url:unknown;children:React.ReactNode}){const href=safeUrl(url);return href?<a className="text-link" href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={14}/></a>:<span className="muted">來源未連結</span>;}

export default function Dashboard({signedIn,signInPath,loadData,onSignIn,signInLabel,signInDisabledReason,account,notice}:{notice?:string|null;signInDisabledReason?:string|null;signedIn:boolean;signInPath?:string;loadData?:()=>Promise<any>;onSignIn?:()=>void;signInLabel?:string;account?:DashboardAccount|null}){
 const [tab,setTab]=useState<Tab>('overview');const [coverageFilter,setCoverageFilter]=useState<CoverageFilter>('all');const [mobile,setMobile]=useState(false);
 const [snapshot,setSnapshot]=useState<any>({});const [loading,setLoading]=useState(false);const inFlight=useRef(false);const retryAt=useRef(0);
 const [periodKind,setPeriodKind]=useState('year');const today=taipeiToday();const [anchor,setAnchor]=useState(today);
 const [clientId,setClient]=useState('');const [brand,setBrand]=useState('');const [status,setStatus]=useState('');const [search,setSearch]=useState('');const [moreFilters,setMoreFilters]=useState(false);const [activityOn,setActivityOn]=useState(false);const [activityStart,setActivityStart]=useState(today.slice(0,7)+'-01');const [activityEnd,setActivityEnd]=useState(today);const [selected,setSelected]=useState<string|null>(null);const [chartMetric,setChartMetric]=useState<ChartMetric>('invoiced');const [stageFilter,setStageFilter]=useState<ProjectFilter>('all');const [accountOpen,setAccountOpen]=useState(false);const accountRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!accountOpen)return;const close=(e:MouseEvent|KeyboardEvent)=>{if(e instanceof KeyboardEvent?e.key==='Escape':!accountRef.current?.contains(e.target as Node))setAccountOpen(false);};document.addEventListener('mousedown',close);document.addEventListener('keydown',close);return ()=>{document.removeEventListener('mousedown',close);document.removeEventListener('keydown',close);};},[accountOpen]);
 const refresh=useCallback(async()=>{
  if(inFlight.current||Date.now()<retryAt.current)return;inFlight.current=true;setLoading(true);
  try{const payload:any=loadData?await loadData():await (await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store',credentials:'same-origin'})).json();setSnapshot((previous:any)=>applyRefresh(previous,payload));if(payload.retryAfterMs)retryAt.current=Date.now()+payload.retryAfterMs;}
  catch{setSnapshot((previous:any)=>applyRefresh(previous,{status:'network_error',message:'目前無法連線至資料來源，請稍後重新整理。'}));}
  finally{inFlight.current=false;setLoading(false);}
 },[loadData]);
 useEffect(()=>{if(signedIn)void refresh();},[signedIn,refresh]);
 const data:Dataset|undefined=snapshot.data;
 const period=useMemo(()=>makePeriod(periodKind,anchor,today),[periodKind,anchor,today]);
 const years=useMemo(()=>periodYears(data,today),[data,today]);
 // Typing in the search box re-runs every analysis: let React finish the keystroke first.
 const deferredSearch=useDeferredValue(search);
 const filters=useMemo(()=>({period,today,clientId,brand,status,search:deferredSearch,activity:activityOn?{start:activityStart,end:activityEnd}:undefined}),[period,today,clientId,brand,status,deferredSearch,activityOn,activityStart,activityEnd]);
 const a=useMemo(()=>data?derive(data,filters):null,[data,filters]);
 // Heavy views are computed only on the tab that shows them.
 const coverage=useMemo(()=>data&&a&&(tab==='overview'||tab==='coverage')?documentCoverage(data,a,period):null,[data,a,period,tab]);
 const follow=useMemo(()=>a?followupView(a.cases,a.latestQuotes,today):null,[a,today]);
 const prior=useMemo(()=>data&&periodKind!=='all'&&tab==='overview'?derive(data,{...filters,period:period.previous}):null,[data,filters,periodKind,period,tab]);
 // Same filters over every date: receivables that are still open do not disappear when a new year starts.
 const allDates=useMemo(()=>data&&periodKind!=='all'&&tab==='finance'?derive(data,{...filters,period:{start:null,end:null}}):a,[data,filters,periodKind,a,tab]);
 // No filters at all: client history and the case drawer for a case outside the current filters.
 const needEverything=tab==='clients'||(!!selected&&!a?.cases.some(c=>c.id===selected));
 const everything=useMemo(()=>data&&needEverything?derive(data,{period:{start:null,end:null},today}):null,[data,today,needEverything]);
 const selectedCase=a?.cases.find(c=>c.id===selected)??(selected?everything?.cases.find(c=>c.id===selected):null)??null;const activeTab=tabs.find(t=>t.key===tab)!;
 const navigate=(next:Tab)=>{setTab(next);setMobile(false);};
 const activeFilterCount=[clientId,brand,status,search,activityOn].filter(Boolean).length;
 const reset=()=>{setClient('');setBrand('');setStatus('');setSearch('');setActivityOn(false);};
 const brands=[...new Set((data?.cases??[]).map(c=>text(c.brand)).filter(Boolean))].sort();
 const error=snapshot.error;const sources=Object.values(data??{}).reduce((sum,rows)=>sum+rows.length,0);
 return <div className="app-shell">
  {mobile&&<button className="sidebar-scrim" aria-label="關閉選單" onClick={()=>setMobile(false)}/>}
  <aside className={`sidebar ${mobile?'is-open':''}`}>
   <a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('overview');}} aria-label="沃克思營運總覽"><span className="brand-mark"><span/><span/><span/></span><span><b>沃克思</b><small>WORKS & CO.</small></span></a>
   
   <nav aria-label="主要導覽">{tabs.map((t,index)=><Fragment key={t.key}>{t.group!==tabs[index-1]?.group&&<span className="nav-group">{t.group}</span>}<button className={`nav-item ${tab===t.key?'active':''}`} onClick={()=>navigate(t.key)} aria-current={tab===t.key?'page':undefined}><t.icon size={18}/><span>{t.label}</span>{t.key==='review'&&!!a&&(a.reconciliation.length+a.issues.length)>0?<em>{a.reconciliation.length+a.issues.length}</em>:t.key==='followups'&&!!follow&&follow.totals.due.count>0?<em>{follow.totals.due.count}</em>:tab===t.key?<span className="nav-dot"/>:null}</button></Fragment>)}</nav>
   <div className="sidebar-bottom"><div className="source-card"><span className="source-icon"><Database size={17}/></span><strong>你的營運資料</strong><p>在 Google Sheets 編輯，<br/>回到這裡掌握全貌。</p>{snapshot.links?.spreadsheet?<a href={snapshot.links.spreadsheet} target="_blank" rel="noopener noreferrer">開啟資料表 <ArrowUpRight size={15}/></a>:<span className="source-pending">{loading?'正在連結資料來源…':'等待資料來源連結'}</span>}</div><div className="owner"><span className="avatar">W</span><div><strong>沃克思國際</strong><small>私人營運空間</small></div><ShieldCheck size={16}/></div></div>
  </aside>
  <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="開啟選單" onClick={()=>setMobile(true)}><Menu size={20}/></button><span>工作空間</span><ChevronRight size={14}/><strong>{activeTab.label}</strong></div><div className="topbar-right" ref={accountRef}><button className="avatar-button" aria-haspopup="menu" aria-expanded={accountOpen} aria-label="帳號與日期" onClick={()=>setAccountOpen(o=>!o)}>{account?account.email.slice(0,1).toUpperCase():<ShieldCheck size={16}/>}</button>{accountOpen&&<div className="account-pop" role="menu"><div className="account-row"><ShieldCheck size={15}/><div><small>目前登入</small><strong>{account?account.email:'僅限本人'}</strong></div></div><div className="account-row"><CalendarDays size={15}/><div><small>今天</small><strong>{today.replaceAll('-','.')} · Asia / Taipei</strong></div></div>{account&&<button role="menuitem" className="account-signout" onClick={()=>{setAccountOpen(false);account.onSignOut();}}>登出</button>}</div>}</div></header>
   <main><section className="page-heading"><div><span className="eyebrow">WORKS BUSINESS / {activeTab.en}</span><h1>{activeTab.label}<span className="heading-dot">.</span></h1><p>{tab==='overview'?'每個案件的進展，都在這裡。':tab==='quotes'?'保留每一次報價，清楚辨識正式成交版本。':tab==='clients'?'誰是主要客戶、誰很久沒合作了。':tab==='calendar'?'接下來有哪些活動、各需要多少人。':tab==='followups'?'報價送出之後，別讓案子靜靜過期。':tab==='finance'?'開了發票就是應收，收到款再標記已收。':tab==='projects'?'從需求到結案，掌握每個階段。':tab==='subcontracts'?'發包給廠商的報價與發票，對照每案的開票收入。':'把需要確認的地方，變成可靠的紀錄。'}</p></div><div className="heading-actions"><div className={`sync-status ${snapshot.stale?'stale':''}`}><span className={loading?'pulse':''}/>{loading?'正在讀取最新資料':snapshot.stale?'目前顯示上次資料':snapshot.loadedAt?`更新於 ${new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(snapshot.loadedAt))}`:'尚未讀取資料'}</div><button className="button secondary refresh-button" disabled={loading||!signedIn} onClick={refresh}><RefreshCw size={15} className={loading?'spin':''}/>{loading?'讀取中':'重新整理'}</button><a className="button primary" href="https://claude.ai/artifact/9CRq755gdGTSAJVHiCg8V7" target="_blank" rel="noopener noreferrer">新增報價 <ArrowUpRight size={14}/></a></div></section>
    {notice&&<div className="notice error" role="alert"><AlertCircle size={18}/><div><strong>{notice}</strong></div></div>}
    {error&&<div className={`notice ${snapshot.stale?'warning':'error'}`} role="alert"><AlertCircle size={18}/><div><strong>{snapshot.stale?'重新整理未成功，資料可能已過期':'暫時無法讀取資料'}</strong><p>{error.message||'資料來源未確認讀取成功。'}{error.retryAfterMs?` 請至少等待 ${Math.ceil(error.retryAfterMs/1000)} 秒再試。`:''}</p>{error.requestId&&<small>查詢編號：{text(error.requestId)}</small>}</div>{error.status==='reauthentication_required'&&error.signInPath&&<a className="button secondary" href={error.signInPath} target="_top">連結 Google Drive <ArrowUpRight size={14}/></a>}</div>}
    {!signedIn?<section className="signin-panel"><span className="signin-logo"><ShieldCheck size={32}/></span><span className="eyebrow">YOUR PRIVATE WORKSPACE</span><h2>營運全貌，留在你的私人空間。</h2><p>登入後，從你已連結的 Google Sheets 讀取最新資料。<br/>網站只供檢視，紀錄由你在資料表中管理。</p>{onSignIn?<><button className="button primary" onClick={onSignIn} disabled={!!signInDisabledReason} style={signInDisabledReason?{cursor:'not-allowed'}:undefined}>{signInLabel??'登入'} <ArrowRight size={16}/></button>{signInDisabledReason&&<p className="filter-help" role="status">{signInDisabledReason}</p>}</>:<a href={signInPath} target="_top" className="button primary">使用 ChatGPT 登入 <ArrowRight size={16}/></a>}</section>:<>
    <section className="filter-bar" aria-label="資料篩選"><div className="period-control"><CalendarDays size={16}/><select aria-label="統計期間" value={periodKind} onChange={e=>setPeriodKind(e.target.value)}><option value="all">全部期間</option><option value="month">月份</option><option value="quarter">季度</option><option value="year">年度</option></select>{periodKind!=='all'&&<PeriodPicker kind={periodKind} anchor={anchor} years={years} onChange={setAnchor}/>}</div><span className="filter-divider"/><select aria-label="付款公司" value={clientId} onChange={e=>setClient(e.target.value)}><option value="">所有付款公司</option>{data?.clients.map(c=><option key={text(c.id)} value={text(c.id)}>{text(c.name)}</option>)}</select><div className="filter-spacer"/><button className={`filter-button ${moreFilters?'selected':''}`} onClick={()=>setMoreFilters(!moreFilters)} aria-expanded={moreFilters}><SlidersHorizontal size={15}/>更多篩選{activeFilterCount>0&&<b>{activeFilterCount}</b>}</button></section>
    {moreFilters&&<section className="expanded-filters"><label className="search-input"><Search size={16}/><input aria-label="搜尋案件" placeholder="搜尋案號、案名或公司" value={search} onChange={e=>setSearch(e.target.value)}/></label><select aria-label="商機狀態" value={status} onChange={e=>setStatus(e.target.value)}><option value="">所有商機狀態</option>{['需求接洽','準備報價','已報價待確認','已成交','未成交','待核對'].map(s=><option key={s}>{s}</option>)}</select><label className="checkbox-label"><input type="checkbox" checked={activityOn} onChange={e=>setActivityOn(e.target.checked)}/>活動日期重疊</label>{activityOn&&<div className="date-range"><input aria-label="活動篩選開始日" type="date" value={activityStart} onChange={e=>setActivityStart(e.target.value)}/><span>至</span><input aria-label="活動篩選結束日" type="date" value={activityEnd} min={activityStart} onChange={e=>setActivityEnd(e.target.value)}/></div>}<button className="text-button" onClick={reset}>清除篩選</button>{activityOn&&<p className="filter-help">僅篩選活動期間有重疊的案件；金額保留原額，不按天數分攤。</p>}</section>}
    {a&&data?<><div className="scope-line"><span><span className="scope-dot"/>{period.label}{period.start?` · ${period.start} — ${period.end}`:''}</span><span>金額：新臺幣 TWD</span></div>
     {tab==='overview'&&<>{follow!.totals.all.count>0&&<div className="follow-strip"><BellRing size={17}/><p><strong>追案提醒</strong>{follow!.totals.due.count>0?`${follow!.totals.due.count} 案已到追案日 · `:''}{follow!.totals.fresh.count} 案報價 30 天內待回覆 · {follow!.totals.stale.count} 案報價超過 90 天未決定</p><button className="text-link" onClick={()=>navigate('followups')}>查看追案清單<ArrowRight size={15}/></button></div>}<Metrics a={a} prior={prior} period={period} yearly={periodKind==='year'} value={chartMetric} onChange={setChartMetric}/><div className="dashboard-grid"><section className="panel trend-panel"><PanelTitle title="營收的每一步" sub="依各自日期歸屬 · 已知金額" action={<span className="subtle-tag">{periodKind==='all'?'最近 12 個有紀錄月份':period.label}</span>}/><div className="chart-tabs">{([{key:'sales',label:'成交未稅'},{key:'quoted',label:'已報價未稅'},{key:'invoiced',label:'已開票未稅'},{key:'pending',label:'待成交未稅'}] as const).map(m=><button key={m.key} onClick={()=>setChartMetric(m.key)} className={chartMetric===m.key?'active':''} aria-pressed={chartMetric===m.key}>{m.label}</button>)}</div><Trend data={a.trends.slice(-12)} metric={chartMetric} prev={periodKind==='year'?prior?.trends:undefined}/><div className="chart-foot"><span className="legend-dot"/> {chartMetric==='invoiced'?'按發票開立日':chartMetric==='sales'?'按成交認定日 · 有效發票未稅':'同案號最新版本 · 按報價日'}{periodKind==='year'&&<em className="legend-prev">去年同月</em>}<span>缺少金額的紀錄不計入曲線</span></div></section><section className="panel customer-panel"><PanelTitle title="主要合作客戶" sub="依已開票未稅 · 付款公司"/><Ranking a={a} select={setClient}/></section></div><div className="bottom-full"><section className="panel"><PanelTitle title="案件進度一覽" sub="件數占比與未稅金額 · 報價依最新報價，開票與結案依發票（含追加）" action={<button className="text-link" onClick={()=>navigate('projects')}>查看案件<ArrowRight size={15}/></button>}/><Stages a={a} pick={s=>{setStageFilter(s);navigate('projects');}}/></section></div><div className="quality-strip"><span className="quality-icon"><Info size={17}/></span><div><strong>每一個數字，都保留它的依據。</strong><p>{a.metrics.unknownQuotedCount} 件最新報價金額待核對 · {a.metrics.ambiguousCount} 件商機關聯待確認。來源涵蓋期間尚須核對，不代表完整營業紀錄。</p></div><button className="text-link" onClick={()=>navigate('review')}>查看待核對<ArrowRight size={15}/></button></div><div className="overview-bottom"><CoverageSummary coverage={coverage!} open={f=>{setCoverageFilter(f);navigate('coverage');}}/></div></>}
     {tab==='quotes'&&<Quotes data={data} a={a} period={period} select={setSelected}/>}{tab==='calendar'&&<Activities a={a} data={data} today={today} select={setSelected}/>}{tab==='clients'&&<Clients data={data} all={everything!} today={today} pick={id=>{setClient(id);navigate('projects');}}/>}{tab==='followups'&&<Followups rows={follow!} data={data} select={setSelected}/>}{tab==='finance'&&<Finance data={data} a={a} all={allDates!} today={today} select={setSelected}/>}{tab==='subcontracts'&&<Subcontracts data={data} a={a} period={period} select={setSelected}/>}{tab==='projects'&&<section className="panel"><PanelTitle title="所有案件" sub={`${a.cases.length} 件紀錄 · 依進度排序；財務期間不隱藏進行中案件`}/><ProjectTable a={a} data={data} select={setSelected} stage={stageFilter} setStage={setStageFilter}/></section>}{tab==='coverage'&&<DocumentCoveragePanel coverage={coverage!} filter={coverageFilter} setFilter={setCoverageFilter} select={setSelected}/>}{tab==='review'&&<Review a={a} data={data} select={setSelected}/>}
     <footer className="page-footer"><span>WORKS & CO. <span className="footer-dot">/</span> 讓每一次合作，都有跡可循。</span><span><Database size={12}/>{sources.toLocaleString()} 筆來源紀錄 · 即時讀取 Google Sheets</span></footer>
    </>:loading?<Loading/>:<section className="panel no-source"><Empty title="準備好，從可靠的資料開始" description="連結完成後，重新整理即可看到案件與財務全貌。這裡不會顯示範例金額。"/><button className="button primary" onClick={refresh}><RefreshCw size={16}/>重新讀取來源</button></section>}</>}
   </main></div>{selectedCase&&data&&<CaseDrawer c={selectedCase} data={data} close={()=>setSelected(null)}/>}</div>;
}

function Metrics({a,prior,period,yearly,value,onChange}:{a:Analysis;prior:Analysis|null;period:any;yearly:boolean;value:ChartMetric;onChange:(m:ChartMetric)=>void}){
 const m=a.metrics;
 // Compare when the sheet declares coverage of the prior period, or the prior period plainly has records.
 const covered=(!!a.coverage.start&&!!a.coverage.end&&!!period.previous.start&&a.coverage.start<=period.previous.start&&a.coverage.end>=period.end)||(!!prior&&prior.metrics.invoiceCount+prior.metrics.quotedCount>0);
 const prevLabel=yearly?'去年同期':'上期同進度';
 const cards=[
  {label:'已成交案件數',value:m.wonCount,known:undefined,note:`獨立原案 · 追加不重複計數${m.ambiguousCount?` · ${m.ambiguousCount} 件關聯待核對`:''}`,prev:prior?.metrics.wonCount,icon:Check,currency:false,metric:'sales' as ChartMetric},
  {label:'已報價金額（未稅）',value:m.quotedNet,known:m.knownQuotedNet,note:`${m.quotedCount} 個案號最新報價 · 按報價日${m.unknownQuotedCount?` · ${m.unknownQuotedCount} 案金額待核對`:''}`,prev:prior?.metrics.quotedNet,icon:FileText,currency:true,metric:'quoted' as ChartMetric},
  {label:'已開票金額（未稅）',value:m.invoiceNet,known:m.knownInvoiceNet,note:`${m.invoiceCount} 張有效發票 · 按開票日${a.taxUnconfirmedCount?` · ${a.taxUnconfirmedCount} 張稅額待核對`:''}`,prev:prior?.metrics.invoiceNet,icon:Wallet,currency:true,metric:'invoiced' as ChartMetric},
  {label:'待成交金額／案數',value:m.pendingNet,known:m.knownPendingNet,note:`${m.pendingQuotedCount} 案待成交 · 最新報價未稅${m.unknownPendingCount?` · ${m.unknownPendingCount} 案金額待核對`:''}`,prev:undefined as number|undefined,noCompare:'待成交是目前狀態，不與前期比較',icon:Clock3,currency:true,metric:'pending' as ChartMetric},
 ];
 return <div className="metrics" role="group" aria-label="選擇趨勢圖指標">{cards.map((card,i)=>{const delta=compare(card.value,card.prev??null,covered);const active=value===card.metric;return <button type="button" key={card.label} className={`metric-card ${active?'active':''}`} aria-pressed={active} onClick={()=>onChange(card.metric)}><div className="metric-label"><span>{card.label}</span><card.icon size={17}/></div><div className="metric-value">{card.value===null?card.known!==undefined?<><span className="currency">已知 NT$</span>{fmt(card.known)}</>:<span className="unknown-value">尚待確認</span>:<>{card.currency&&<span className="currency">NT$</span>}{fmt(card.value)}{!card.currency&&<small>件</small>}</>}</div><div className="metric-note">{card.note}</div><div className="metric-bottom">{card.value===null&&card.known!==undefined?<span>完整總額 <b>尚待核對</b></span>:'noCompare' in card?<span>{card.noCompare}</span>:delta===null?<span>{prior?`${prevLabel}無可比較資料`:'選擇月份、季度或年度可與前期比較'}</span>:<span className={delta>=0?'positive':'negative'}>{delta>=0?'↗':'↘'} {Math.abs(delta).toFixed(1)}% <b>較{prevLabel} {card.currency?`NT$ ${fmt(card.prev)}`:`${fmt(card.prev)} 件`}</b></span>}<span className="metric-stamp" aria-hidden="true">{String(i+1).padStart(2,'0')}</span></div></button>;})}</div>;
}
function Trend({data,metric,prev}:{data:Analysis['trends'];metric:ChartMetric;prev?:Analysis['trends']}){
 const [hover,setHover]=useState<number|null>(null);data=data.filter(d=>d[`${metric}KnownCount`]>0);if(!data.length)return <Empty title="此期間尚無可呈現的金額" description="有有效日期與金額的紀錄，才會顯示在趨勢中。"/>;
 const lastYear=new Map((prev??[]).filter(d=>d[`${metric}KnownCount`]>0).map(d=>[`${Number(d.month.slice(0,4))+1}${d.month.slice(4)}`,d[metric]]));const max=Math.max(...data.map(d=>d[metric]),...data.map(d=>lastYear.get(d.month)??0),1);const unit=Math.pow(10,Math.floor(Math.log10(max)));const top=Math.ceil(max/4/unit)*4*unit||1;
 const points=data.map((d,index)=>({x:64+index/Math.max(data.length-1,1)*660,y:210-d[metric]/top*170,d}));const line=points.map((p,index)=>`${index?'L':'M'}${p.x},${p.y}`).join(' ');const prevLine=points.filter(p=>lastYear.has(p.d.month)).map((p,index)=>`${index?'L':'M'}${p.x},${210-lastYear.get(p.d.month)!/top*170}`).join(' ');const h=hover===null?null:points[hover];const hPrev=h?lastYear.get(h.d.month):undefined;
 return <div className="chart-wrap"><svg viewBox="-34 0 834 260" role="img" aria-label={`每月${metric==='quoted'?'已報價未稅':metric==='invoiced'?'已開票未稅':metric==='sales'?'成交未稅':'待成交未稅'}趨勢`}><defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#378477" stopOpacity=".17"/><stop offset="100%" stopColor="#378477" stopOpacity="0"/></linearGradient></defs>{[0,1,2,3,4].map(t=><g key={t}><line x1="64" x2="724" y1={210-t*42.5} y2={210-t*42.5} stroke="#e9eeeb" strokeDasharray={t?'3 5':undefined}/><text x="48" y={214-t*42.5} textAnchor="end" className="chart-axis">{compact(top*t/4)}</text></g>)}<path d={`${line} L${points.at(-1)!.x},210 L64,210 Z`} fill="url(#areaFill)"/>{prevLine&&<path d={prevLine} stroke="#a9b5ae" strokeWidth="1.8" strokeDasharray="5 5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>}<path d={line} stroke="#377d70" strokeWidth="2.7" fill="none" strokeLinecap="round" strokeLinejoin="round"/>{points.map((p,index)=><g key={p.d.month} onMouseEnter={()=>setHover(index)} onMouseLeave={()=>setHover(null)}><circle cx={p.x} cy={p.y} r={hover===index?5:3.5} fill="#fff" stroke="#377d70" strokeWidth="2"/><rect x={p.x-22} y="24" width="44" height="200" fill="transparent"/><text x={p.x} y="240" className="chart-axis" textAnchor="middle">{data.length<=7?p.d.month.replace('-',' / '):p.d.month.slice(5)+'月'}</text></g>)}{h&&<g pointerEvents="none"><rect x={Math.min(Math.max(h.x-(hPrev===undefined?75:125),64),hPrev===undefined?574:474)} y="4" width={hPrev===undefined?150:250} height="31" rx="6" fill="#183f36"/><text x={Math.min(Math.max(h.x,hPrev===undefined?139:189),hPrev===undefined?649:599)} y="24" textAnchor="middle" fill="#fff" fontSize="11">{h.d.month} · NT$ {fmt(h.d[metric])}{hPrev!==undefined?` · 去年 NT$ ${fmt(hPrev)}`:''}</text></g>}</svg><details className="chart-data"><summary>檢視趨勢數據</summary><DataTable rows={data} columns={[{key:"month",label:"月份",kind:"date",value:(d:typeof data[number])=>d.month,filter:"none"},{key:"amount",label:"已知金額",kind:"num",value:(d:typeof data[number])=>d[metric],filter:"none"},{key:"unknown",label:"金額待確認（筆）",kind:"num",value:(d:typeof data[number])=>metric==="quoted"?d.quotedUnknown:metric==="invoiced"?d.invoiceUnknown:metric==="sales"?d.salesUnknown:d.pendingUnknown,filter:"none"}]} rowKey={d=>d.month} fileName={`趨勢-${metric}`}/></details></div>;
}
const PIE_COLORS=['#1f4a3a','#3f7a5c','#6f9e7a','#a3c3a2','#c8a96a','#d98f5c','#7f9bb3','#b9a3c9'];
function Ranking({a,select}:{a:Analysis;select:(id:string)=>void}){
 const [hover,setHover]=useState<number|null>(null);
 const known=a.ranking.filter(r=>r.knownCount&&r.net>0);
 if(!known.length)return <Empty title="此期間尚無開票紀錄" description="有效發票有未稅金額與付款公司後，即可比較合作概況。"/>;
 const total=known.reduce((t,r)=>t+r.net,0);const TOP=7;
 const top=known.slice(0,TOP);const rest=known.slice(TOP);
 const slices=[...top.map(r=>({id:r.clientId,name:r.name,net:r.net,count:r.count})),...(rest.length?[{id:'',name:`其他 ${rest.length} 家`,net:rest.reduce((t,r)=>t+r.net,0),count:rest.reduce((t,r)=>t+r.count,0)}]:[])];
 const R=70,C=2*Math.PI*R;let offset=0;
 const focus=hover===null?null:slices[hover];
 return <div className="ranking pie-ranking">
  <div className="pie-wrap"><svg viewBox="0 0 180 180" className="pie" role="img" aria-label="主要合作客戶開票占比">
   <circle cx="90" cy="90" r={R} fill="none" stroke="#eef1ec" strokeWidth="30"/>
   {slices.map((x,i)=>{const len=x.net/total*C;const el=<circle key={x.id||'rest'} cx="90" cy="90" r={R} fill="none" stroke={PIE_COLORS[i%PIE_COLORS.length]} strokeWidth={hover===i?36:30} strokeDasharray={`${Math.max(len-1.5,0.5)} ${C}`} strokeDashoffset={-offset} transform="rotate(-90 90 90)" className={x.id?'pie-slice clickable':'pie-slice'} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} onClick={()=>{if(x.id)select(x.id);}}><title>{`${x.name}：${fmt(x.net)}（${(x.net/total*100).toFixed(1)}%）`}</title></circle>;offset+=len;return el;})}
   <text x="90" y="84" textAnchor="middle" className="pie-center-label">{focus?`${(focus.net/total*100).toFixed(1)}%`:'開票未稅'}</text>
   <text x="90" y="104" textAnchor="middle" className="pie-center-value">{focus?fmt(focus.net):fmt(total)}</text>
  </svg></div>
  <ul className="pie-legend">{slices.map((x,i)=><li key={x.id||'rest'}><button type="button" disabled={!x.id} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} onClick={()=>{if(x.id)select(x.id);}} title={x.id?'點選即篩選該公司':`${rest.map(r=>r.name).join('、')}`}><span className="pie-swatch" style={{background:PIE_COLORS[i%PIE_COLORS.length]}}/><span className="pie-name">{x.name}</span><span className="pie-pct">{(x.net/total*100).toFixed(1)}%</span><span className="pie-amount">{fmt(x.net)}</span></button></li>)}</ul>
  <p className="panel-footnote">共 {a.ranking.length} 家付款公司{a.ranking.length>known.length?`（${a.ranking.length-known.length} 家金額待確認未列入）`:''}；點選即篩選該公司。</p>
 </div>;
}
const STAGE_ORDER:CaseStage[]=[...CASE_STAGES,'未成交'];
const OVERVIEW_STAGES:CaseStage[]=['提案','報價','開票','結案'];
const STAGE_HINT:Record<CaseStage,string>={提案:'需求接洽、尚無報價',報價:'已有報價、尚未成交',成交:'已成交、尚未開票',開票:'已開出有效發票',結案:'結案狀態填「已結案」',未成交:'未成交或取消'};
function StageStepper({c,compact}:{c:DerivedCase;compact?:boolean}){
 if(c.stage==='未成交')return <div className="stepper lost"><Badge>未成交</Badge></div>;
 const current=CASE_STAGES.indexOf(c.stage as typeof CASE_STAGES[number]);
 return <div className={`stepper ${compact?'compact':''}`} aria-label={`目前進度：${c.stage}`}><ol>{CASE_STAGES.map((s,i)=><li key={s} className={i<current?'done':i===current?'current':''} title={s}><span className="dot"/>{!compact&&<span className="label">{s}</span>}</li>)}</ol>{compact&&<b className="stepper-current">{c.stage}</b>}{c.stageFlag&&<small className="amber-text">{c.stageFlag}</small>}</div>;
}
function Stages({a,pick}:{a:Analysis;pick:(s:CaseStage)=>void}){
 const roots=a.cases.filter(c=>!c.parentId);const count=(s:CaseStage)=>roots.filter(c=>c.stage===s).length;const summary=stageSummary(a.cases,a.latestQuotes,OVERVIEW_STAGES);
 return <div className="stages"><div className="stage-bar">{OVERVIEW_STAGES.map(s=>count(s)>0?<button key={s} className={`seg seg-${s}`} style={{flex:count(s)}} title={`${s}：${count(s)}`} aria-label={`${s} ${count(s)} 件`} onClick={()=>pick(s)}/>:null)}{!roots.length&&<span className="seg" style={{flex:1}}/>}</div><div className="stage-grid">{summary.map(x=><button key={x.stage} className="stage-pick" onClick={()=>pick(x.stage)}><span className={`stage-dot seg-${x.stage}`}/><span>{x.stage}<small>{STAGE_HINT[x.stage]}</small></span><span className="stage-figures"><b>{x.count}<em>件</em></b><small>{x.share.toFixed(0)}%{x.stage!=='提案'&&<> · NT$ {fmt(x.amount)}</>}{x.unknown>0&&<i title="金額待核對的案件"> · {x.unknown} 件待核對</i>}</small></span></button>)}</div><div className="execution-note"><span><b>{a.cases.filter(c=>c.executionStatus==='執行中').length}</b> 執行中</span><span><b>{a.cases.filter(c=>c.executionStatus==='執行完成').length}</b> 執行完成</span><span><b>{a.metrics.ambiguousCount}</b> 關聯待核對</span></div></div>;
}
function ProjectTable({a,data,select,stage,setStage}:{a:Analysis;data:Dataset;select:(id:string)=>void;stage:ProjectFilter;setStage:(s:ProjectFilter)=>void}){
 if(!a.cases.length)return <Empty/>;
 const rank=(c:DerivedCase)=>STAGE_ORDER.indexOf(c.stage);
 const invoiced=(c:DerivedCase)=>c.invoicedGross!==null;
 const rows=a.cases.filter(c=>stage==='all'||(stage==='invoiced'?invoiced(c):c.stage===stage)).map((c,i)=>({c,i})).sort((x,y)=>rank(x.c)-rank(y.c)||x.i-y.i).map(x=>x.c);
 const clientName=(c:DerivedCase)=>text(data.clients.find(x=>x.id===c.clientId)?.name)||'待確認';
 const caseAc=new Map<string,number|null>();for(const q of a.latestQuotes)if(q.caseIds.length===1)caseAc.set(q.caseIds[0],acFeeOf(q.quotes));
 const columns:Column<DerivedCase>[]=[
  {key:'number',label:'案號',value:c=>text(c.number),filter:'text',width:'96px',render:c=><span className="case-number">{text(c.number)}{c.parentId&&<span className="addition-label">追加</span>}</span>},
  {key:'title',label:'案名',value:c=>text(c.title)||'未命名案件',filter:'text',render:c=><strong className="cell-strong">{text(c.title)||'未命名案件'}</strong>},
  {key:'client',label:'付款公司',value:clientName,filter:'select'},
  {key:'stage',label:'進度',value:c=>c.stage,filter:'select',width:'240px',render:c=><StageStepper c={c} compact/>},
  {key:'payment',label:'款別',value:c=>c.paymentTypes||'—',filter:'select'},
  {key:'net',label:'成交未稅（依發票）',kind:'num',value:c=>c.saleNet,filter:'none'},
  {key:'ac',label:'毛利（AC 費）',kind:'num',value:c=>caseAc.get(text(c.id))??null,filter:'none'},
  {key:'date',label:'依據日期',kind:'date',value:c=>c.saleDate,filter:'text'},
 ];
 const quoteNet=new Map<string,number|null>();for(const q of a.latestQuotes)for(const id of q.caseIds)quoteNet.set(id,q.caseIds.length===1?q.net:null);
 const sumOf=(list:DerivedCase[],v:(c:DerivedCase)=>number|null|undefined)=>{const known=list.map(v).filter((x):x is number=>x!=null);return known.length?known.reduce((t,x)=>t+x,0):null;};
 const proposing=a.cases.filter(c=>c.stage==='提案'),quoting=a.cases.filter(c=>c.stage==='報價'),billed=a.cases.filter(invoiced);
 const cards:{key:ProjectFilter;label:string;count:number;note:string}[]=[
  {key:'all',label:'全部案件',count:a.cases.length,note:'含追加案'},
  {key:'提案',label:'提案中',count:proposing.length,note:'需求接洽、尚無報價'},
  {key:'報價',label:'報價中',count:quoting.length,note:`報價未稅 NT$ ${fmt(sumOf(quoting,c=>quoteNet.get(text(c.id))))}`},
  {key:'invoiced',label:'已開票',count:billed.length,note:`開票未稅 ${knownNote(sumOf(billed,c=>c.invoicedNet),billed.filter(c=>c.invoicedNet==null).length,'案')}`},
 ];
 const other=stage!=='all'&&!cards.some(k=>k.key===stage);
 return <><KpiCards label="依進度篩選" value={stage as ProjectFilter} onChange={setStage} items={cards.map(k=>({key:k.key,label:k.label,value:k.count,unit:"筆",note:k.note}))}/>
 {other&&<div className="stage-filter-note">目前只顯示「{stage}」階段<button className="text-button" onClick={()=>setStage('all')}><X size={13}/>清除</button></div>}
 <DataTable rows={rows} columns={columns} rowKey={c=>text(c.id)} onRowClick={c=>select(text(c.id))} fileName="案件進度" empty={stage==='all'?'沒有案件':'沒有符合的案件'}/></>;
}
function Quotes({data,a,period,select}:{data:Dataset;a:Analysis;period:any;select:(id:string)=>void}){
 const [view,setView]=useState<QuoteView>('all');
 const ids=new Set(a.cases.map(c=>c.id));const quotes=data.quotes.filter(q=>ids.has(q.caseId)&&inPeriod(q.date,period));const latestIds=new Set(a.latestQuotes.flatMap(q=>q.quotes.map(v=>v.id)));const unresolvedIds=new Set(a.latestQuotes.filter(q=>!q.quote).flatMap(q=>q.caseIds));
 const byCase=new Map(a.cases.map(c=>[c.id,c]));
 const status=(q:typeof quotes[number])=>latestIds.has(q.id)?'最新報價（計入）':a.pendingImportIds.has(text(q.id))?'匯入待核對':unresolvedIds.has(text(q.caseId))?'版本待核對':'舊版留存';
 const columns:Column<typeof quotes[number]>[]=[
  {key:'case',label:'案號',value:q=>text(byCase.get(q.caseId)?.number),filter:'text',width:'90px'},
  {key:'title',label:'報價名稱',value:q=>text(q.title)||text(byCase.get(q.caseId)?.title),filter:'text',render:q=><button className="case-button" onClick={e=>{e.stopPropagation();select(text(q.caseId));}}><strong>{text(q.title)||text(byCase.get(q.caseId)?.title)}</strong></button>},
  {key:'date',label:'報價日',kind:'date',value:q=>parseDate(q.date),filter:'text'},
  {key:'version',label:'版本',value:q=>text(q.version)||'未註明',filter:'select'},
  {key:'role',label:'範圍',value:q=>text(q.role)||'待確認',filter:'select'},
  {key:'status',label:'統計版本',value:status,filter:'select',render:q=><Badge tone={latestIds.has(q.id)?'green':a.pendingImportIds.has(text(q.id))||unresolvedIds.has(text(q.caseId))?'amber':'neutral'}>{status(q)}</Badge>},
  {key:'net',label:'未稅',kind:'num',value:q=>money(q.net),filter:'none'},
  {key:'gross',label:'含稅',kind:'num',value:q=>money(q.gross),filter:'none'},
  {key:'rate',label:'服務費率',kind:'num',value:q=>percentOf(money(q.feeRate)),format:PERCENT,filter:'none',render:q=>{const r=percentOf(money(q.feeRate));return r===null?<span className="muted">待補</span>:`${r}%`;}},
  {key:'ac',label:'AC 費（毛利）',kind:'num',value:q=>acFee(q),filter:'none'},
  {key:'source',label:'原始報價',value:q=>data.documents.find(d=>d.id===q.sourceId)?.url?'有':'未連結',filter:'select',render:q=><SourceLink url={data.documents.find(d=>d.id===q.sourceId)?.url}>開啟</SourceLink>},
 ];
 const pending=quotes.filter(q=>status(q)==='版本待核對'),latest=quotes.filter(q=>status(q)==='最新報價（計入）');
 const sumNet=(list:typeof quotes)=>{const known=list.map(q=>money(q.net)).filter((x):x is number=>x!=null);return known.length?known.reduce((t,x)=>t+x,0):null;};
 const cards:{key:QuoteView;label:string;count:number;unit:string;note:string}[]=[
  {key:'all',label:'總報價數',count:quotes.length,unit:'份',note:'期間內所有版本，含舊版'},
  {key:'pending',label:'版本待核對',count:pending.length,unit:'份',note:`${new Set(pending.map(q=>text(q.caseId))).size} 案無法判定採用哪一版`},
  {key:'latest',label:'最新報價',count:latest.length,unit:'份',note:`${new Set(latest.map(q=>text(q.caseId))).size} 案 · 未稅 ${knownNote(sumNet(latest),latest.filter(q=>money(q.net)===null).length,'份')}`},
 ];
 const withAc=latest.filter(q=>acFee(q)!==null),acTotal=withAc.reduce((t,q)=>t+acFee(q)!,0),acNet=sumNet(withAc);
 const shown=view==='pending'?pending:view==='latest'?latest:view==='ac'?withAc:quotes;
 return <><KpiCards className="page-kpis" label="依統計版本篩選" value={view} onChange={setView} items={[...cards.map(k=>({key:k.key,label:k.label,value:k.count,unit:k.unit,note:k.note})),{key:'ac' as QuoteView,label:'毛利（AC 費）',prefix:'NT$',value:fmt(withAc.length?acTotal:null),note:`${withAc.length} 份最新報價有服務費率${acNet?` · 占未稅 ${Math.round(acTotal/acNet*1000)/10}%`:''}${latest.length-withAc.length?` · ${latest.length-withAc.length} 份待補`:''}`}]}/><section className="panel"><PanelTitle title="報價版本紀錄" sub="按報價日期篩選 · 點欄名排序，第二列可篩選 · 點選列檢視案件"/>{!quotes.length?<Empty/>:<DataTable rows={shown} columns={columns} rowKey={q=>text(q.id)} onRowClick={q=>select(text(q.caseId))} fileName="報價版本紀錄"/>}</section></>;
}
function Subcontracts({data,a,period,select}:{data:Dataset;a:Analysis;period:any;select:(id:string)=>void}){
 const [view,setView]=useState<'all'|'invoiced'|'vendors'>('all');
 const v=subcontractView(data,a.cases,period);const t=v.totals;
 const pct=(x:number|null)=>x===null?'—':`${x.toFixed(1)}%`;
 type R=typeof v.rows[number];
 const byCase=new Map(a.cases.map(c=>[text(c.id),c]));
 const caseCols:Column<CaseCost>[]=[
  {key:'number',label:'案號',value:c=>c.number,filter:'text',width:'96px'},
  {key:'title',label:'案名',value:c=>c.title,filter:'text',render:c=><strong className="cell-strong">{c.title||'—'}</strong>},
  {key:'vendors',label:'發包廠商',value:c=>c.vendors.join('、'),filter:'text'},
  {key:'revenue',label:'開票未稅',kind:'num',value:c=>c.revenueNet,filter:'none'},
  {key:'cost',label:'發包未稅',kind:'num',value:c=>c.costNet,filter:'none',render:c=><>{fmt(c.costNet)}{c.costUnknown>0&&<small className="amber-text">{c.costUnknown} 筆金額待補</small>}</>},
  {key:'margin',label:'開票減發包',kind:'num',value:c=>c.margin,filter:'none',render:c=>c.margin===null?<span className="muted">待確認</span>:<span className={c.margin<0?'amber-text':''}>{fmt(c.margin)}</span>},
  {key:'rate',label:'開票減發包比率',kind:'num',value:c=>c.marginRate,format:PERCENT,filter:'none',render:c=>pct(c.marginRate)},
 ];
 const cols:Column<R>[]=[
  {key:'case',label:'案號',value:r=>text(byCase.get(text(r.caseId))?.number)||text(r.caseNumber),filter:'text',width:'96px'},
  {key:'vendor',label:'發包廠商',value:r=>text(r.vendor),filter:'select'},
  {key:'kind',label:'文件類型',value:r=>text(r.kind),filter:'select'},
  {key:'docNo',label:'文件號碼',value:r=>text(r.documentNumber),filter:'text'},
  {key:'date',label:'日期',kind:'date',value:r=>parseDate(r.date),filter:'text'},
  {key:'items',label:'發包項目',value:r=>text(r.items),filter:'text',render:r=><span className="cell-wrap">{text(r.items)||'—'}</span>},
  {key:'net',label:'未稅',kind:'num',value:r=>money(r.net),filter:'none'},
  {key:'tax',label:'稅額',kind:'num',value:r=>money(r.tax),filter:'none'},
  {key:'gross',label:'含稅',kind:'num',value:r=>money(r.gross),filter:'none'},
  {key:'status',label:'狀態',value:r=>text(r.status)||'有效',filter:'select',render:r=><Badge tone={(text(r.status)||'有效')==='有效'?'green':'neutral'}>{text(r.status)||'有效'}</Badge>},
  {key:'source',label:'原件',value:r=>safeUrl(r.sourceUrl)?'有':'未連結',filter:'select',render:r=><SourceLink url={r.sourceUrl}>開啟</SourceLink>},
 ];
 const counted=v.rows.filter(r=>(text(r.status)||'有效')==='有效');
 const vendorMap=new Map<string,{vendor:string;count:number;net:number;unknown:number;invoiced:number;cases:Set<string>}>();
 for(const r of counted){const k=text(r.vendor)||'未填廠商';const x=vendorMap.get(k)??{vendor:k,count:0,net:0,unknown:0,invoiced:0,cases:new Set<string>()};const n=money(r.net);x.count++;if(n==null)x.unknown++;else{x.net+=n;if(text(r.kind)==='發票')x.invoiced+=n;}if(r.caseId)x.cases.add(text(byCase.get(text(r.caseId))?.number)||text(r.caseNumber));vendorMap.set(k,x);}
 type V={vendor:string;count:number;net:number;unknown:number;invoiced:number;cases:Set<string>};
 const vendorRows=[...vendorMap.values()].sort((x,y)=>y.net-x.net);
 const vendorCols:Column<V>[]=[
  {key:'vendor',label:'發包廠商',value:x=>x.vendor,filter:'text',render:x=><strong className="cell-strong">{x.vendor}</strong>},
  {key:'cases',label:'案號',value:x=>[...x.cases].join('、'),filter:'text'},
  {key:'count',label:'有效單據',kind:'num',value:x=>x.count,filter:'none'},
  {key:'net',label:'發包未稅',kind:'num',value:x=>x.net,filter:'none',render:x=><>{fmt(x.net)}{x.unknown>0&&<small className="amber-text">{x.unknown} 筆金額待補</small>}</>},
  {key:'invoiced',label:'已開票未稅',kind:'num',value:x=>x.invoiced,filter:'none'},
  {key:'open',label:'尚未開票',kind:'num',value:x=>x.net-x.invoiced,filter:'none'},
 ];
 const detail=view==='invoiced'?counted.filter(r=>text(r.kind)==='發票'):v.rows;
 return <><KpiCards className="page-kpis" label="切換發包檢視" value={view} onChange={setView} items={[
  {key:'all',label:'總發包金額（未稅）',prefix:'NT$',value:fmt(t.costNet),note:`${t.count} 筆有效單據${t.unknown?` · ${t.unknown} 筆金額待補`:''} · 涉及 ${t.cases} 案`},
  {key:'invoiced',label:'已開票（未稅）',prefix:'NT$',value:fmt(t.invoicedNet),note:`${t.invoicedCount} 張廠商發票 · 尚未開票 NT$ ${fmt(t.costNet-t.invoicedNet)}`},
  {key:'vendors',label:'廠商數',value:t.vendors,unit:'家',note:'點選查看各廠商發包與開票金額'},
 ]}/>
 {view==="vendors"?<section className="panel"><PanelTitle title="各廠商發包與開票" sub="只計狀態「有效」 · 尚未開票 = 報價或請款單金額"/>{!vendorRows.length?<Empty title="此期間沒有發包紀錄"/>:<DataTable rows={vendorRows} columns={vendorCols} rowKey={x=>x.vendor} fileName="各廠商發包"/>}</section>:<section className="panel"><PanelTitle title="各案發包與開票" sub="開票未稅 − 發包未稅 · 發包金額有缺時顯示待確認 · 毛利請看報價的 AC 費"/>{!v.perCase.length?<Empty title="此期間沒有發包紀錄" description="在試算表「發包項目」分頁新增廠商報價或發票後，重新整理即可看到。"/>:<DataTable rows={v.perCase} columns={caseCols} rowKey={c=>c.caseId} onRowClick={c=>select(c.caseId)} fileName="各案發包與開票"/>}</section>}
 <section className="panel"><PanelTitle title={view==="invoiced"?"已開票的廠商發票":"發包單據明細"} sub="廠商報價、發票與請款單 · 依文件日期篩選期間 · 狀態「參考／重複／作廢」不計成本"/>{!detail.length?<Empty title="此期間沒有發包單據"/>:<DataTable rows={detail} columns={cols} rowKey={r=>text(r.id)} onRowClick={r=>{if(r.caseId)select(text(r.caseId));}} fileName="發包單據明細"/>}</section></>;
}
function Finance({data,a,all,today,select}:{data:Dataset;a:Analysis;all:Analysis;today:string;select:(id:string)=>void}){
 const [view,setView]=useState<'all'|'open'|'overdue'|'collected'>('open');
 const m=a.metrics;const byCase=new Map(data.cases.map(c=>[c.id,c]));
 // Open and overdue look at every unpaid invoice up to today; collected and all follow the selected period.
 const open=useMemo(()=>receivableView(all.invoices,today),[all.invoices,today]);
 const r=useMemo(()=>receivableView(a.invoices,today),[a.invoices,today]);const t={...open.totals,collected:r.totals.collected,collectedCount:r.totals.collectedCount,collectedUnknown:r.totals.collectedUnknown};
 const tone=(x:Receivable)=>x.state==='已收款'?'green':x.state==='未收'?'neutral':'amber';
 const columns:Column<Receivable>[]=[
  {key:'number',label:'發票號碼',value:i=>text(i.number),filter:'text'},
  {key:'case',label:'案號',value:i=>text(byCase.get(i.caseId)?.number),filter:'text'},
  {key:'type',label:'款別',value:i=>text(i.type)||'—',filter:'select'},
  {key:'client',label:'付款公司',value:i=>text(data.clients.find(c=>c.id===(i.clientId||byCase.get(i.caseId)?.clientId))?.name)||'待確認',filter:'select'},
  {key:'date',label:'開票日',kind:'date',value:i=>parseDate(i.date),filter:'text'},
  {key:'gross',label:'含稅',kind:'num',value:i=>money(i.gross),filter:'none'},
  {key:'receivable',label:'應收金額',kind:'num',value:i=>i.receivable,filter:'none',render:i=>i.receivable===null?<Badge tone="amber">金額待補</Badge>:fmt(i.receivable)},
  {key:'age',label:'開票後天數',kind:'num',value:i=>i.ageDays,filter:'none'},
  {key:'due',label:'到期日',kind:'date',value:i=>i.due,filter:'text',render:i=>i.due?<>{i.due}{i.dueAssumed&&<small className="muted">推算</small>}</>:'—'},
  {key:'late',label:'逾期天數',kind:'num',value:i=>i.overdueDays,filter:'none',render:i=>i.overdueDays===null?'—':<span className="amber-text">{i.overdueDays} 天</span>},
  {key:'state',label:'收款狀態',value:i=>i.state,filter:'select',render:i=><Badge tone={tone(i)}>{i.state}</Badge>},
  {key:'source',label:'原始發票',value:i=>data.documents.find(d=>d.id===i.sourceId)?.url?'有':'未連結',filter:'select',render:i=><SourceLink url={data.documents.find(d=>d.id===i.sourceId)?.url}>開啟</SourceLink>},
 ];
 const shown=view==='open'?open.open:view==='overdue'?open.overdue:view==='collected'?r.collected:r.rows;
 return <><KpiCards className="page-kpis" label="依收款狀態篩選" value={view} onChange={setView} items={[
  {key:'open',label:'應收帳款（含稅）',prefix:'NT$',value:fmt(t.receivable),note:`${t.openCount} 張尚未標記已收 · 不限開票期間${t.unknown?` · ${t.unknown} 張金額待補`:''}`},
  {key:'overdue',label:'逾期應收（含稅）',prefix:'NT$',value:fmt(t.overdue),note:`${t.overdueCount} 張已過到期日${t.overdueUnknown?`（${t.overdueUnknown} 張金額待補）`:''} · 未填到期日者以開票後 ${DEFAULT_TERM_DAYS} 天計`},
  {key:'collected',label:'已收款（含稅）',prefix:'NT$',value:fmt(t.collected),note:`${t.collectedCount} 張${t.collectedUnknown?`（${t.collectedUnknown} 張金額待補）`:''} · 按開票日篩選 · 發票分頁「已收款」填「是」`},
  {key:'all',label:'有效開票（含稅）',prefix:'NT$',value:fmt(m.invoiceGross),note:`${m.invoiceCount} 張發票 · 按開票日篩選`},
 ]}/><div className="notice soft"><Info size={17}/><p>有開發票就算應收。收到款後，在試算表「發票」分頁的「已收款」欄填「是」，這張發票就會從應收移除。</p></div><section className="panel"><PanelTitle title="發票與應收明細" sub="含稅金額 · 點欄名排序，第二列可篩選"/>{!a.invoices.length&&!open.rows.length?<Empty/>:<DataTable rows={shown} columns={columns} rowKey={i=>text(i.id)} onRowClick={i=>select(text(i.caseId))} fileName="發票與應收明細" empty="沒有符合的發票"/>}</section><p className="section-note">作廢發票不列入。已登錄並確認的收款分配會先從應收金額扣除。</p></>;
}
function Activities({a,data,today,select}:{a:Analysis;data:Dataset;today:string;select:(id:string)=>void}){
 const [view,setView]=useState<'upcoming'|'soon'|'month'|'all'>('upcoming');
 const v=useMemo(()=>activityView(a.cases,a.latestQuotes,data.quoteItems??[],today),[a,data,today]);const t=v.totals;
 const clientName=(r:ActivityRow)=>text(data.clients.find(x=>x.id===r.clientId)?.name)||'待確認';
 const shown=view==='all'?v.rows:view==='soon'?v.rows.filter(r=>r.soon):view==='month'?v.rows.filter(r=>r.thisMonth):v.rows.filter(r=>r.state!=='已結束');
 const people=(x:{headcount:number;unknown:number})=>`人力 ${fmt(x.headcount)} 人次${x.unknown?` · ${x.unknown} 案無明細`:''}`;
 const columns:Column<ActivityRow>[]=[
  {key:'start',label:'活動開始',kind:'date',value:r=>r.start,filter:'text'},
  {key:'end',label:'活動結束',kind:'date',value:r=>r.end,filter:'text'},
  {key:'state',label:'狀態',value:r=>r.state,filter:'select',render:r=><Badge tone={r.state==='進行中'?'green':r.state==='即將開始'?'amber':'neutral'}>{r.state==='即將開始'?`${r.daysUntil} 天後`:r.state}</Badge>},
  {key:'number',label:'案號',value:r=>r.number,filter:'text',width:'96px'},
  {key:'title',label:'案名',value:r=>r.title||'未命名案件',filter:'text',render:r=><strong className="cell-strong">{r.title||'未命名案件'}</strong>},
  {key:'client',label:'付款公司',value:clientName,filter:'select'},
  {key:'days',label:'天數',kind:'num',value:r=>r.days,filter:'none'},
  {key:'headcount',label:'人力（人次）',kind:'num',value:r=>r.headcount,filter:'none',render:r=>r.headcount===null?<span className="muted">無明細</span>:fmt(r.headcount)},
  {key:'stage',label:'進度',value:r=>r.stage,filter:'select'},
  {key:'execution',label:'執行狀態',value:r=>r.execution||'—',filter:'select'},
  {key:'net',label:'報價未稅',kind:'num',value:r=>r.net,filter:'none'},
 ];
 return <><KpiCards className="page-kpis" label="依活動時間篩選" value={view} onChange={setView} items={[
  {key:'upcoming',label:'進行中與未來活動',value:t.upcoming.count,unit:'場',note:people(t.upcoming)},
  {key:'soon',label:'未來 14 天',value:t.soon.count,unit:'場',note:`含進行中 · ${people(t.soon)}`},
  {key:'month',label:'本月活動',value:t.month.count,unit:'場',note:people(t.month)},
  {key:'all',label:'全部有日期的活動',value:t.all.count,unit:'場',note:v.undated?`另有 ${v.undated} 案未填活動日期`:'含已結束'},
 ]}/><div className="notice soft"><Info size={17}/><p>活動日期來自「案件商機」的「活動開始日／活動結束日」。人力人次由最新報價的明細推算：有保險費列時取其人數，否則加總以「位」計價的班次。</p></div><section className="panel"><PanelTitle title="活動清單" sub="即將開始的排最前 · 點選列檢視案件"/>{!v.rows.length?<Empty title="還沒有填活動日期的案件" description="在「案件商機」填上活動開始日，就會出現在這裡。"/>:<DataTable rows={shown} columns={columns} rowKey={r=>r.caseId} onRowClick={r=>select(r.caseId)} fileName="活動行事曆" empty="這段時間沒有活動"/>}</section></>;
}
function Clients({data,all,today,pick}:{data:Dataset;all:Analysis;today:string;pick:(id:string)=>void}){
 const [view,setView]=useState<'all'|'active'|'dormant'|'top'>('all');
 // Client history spans every year, so it ignores the dashboard's period and other filters.
 const v=useMemo(()=>clientView(data.clients,all.cases,all.invoices,all.latestQuotes,today),[data,all,today]);const t=v.totals;
 const shown=view==='active'?v.rows.filter(r=>r.activeThisYear):view==='dormant'?v.rows.filter(r=>r.dormant):view==='top'?v.rows.filter(r=>t.top3Ids.has(r.clientId)):v.rows;
 const pct=(n:number|null)=>n===null?'—':`${Math.round(n*1000)/10}%`;
 const columns:Column<ClientRow>[]=[
  {key:'name',label:'付款公司',value:r=>r.name,filter:'text',render:r=><strong className="cell-strong">{r.name}</strong>},
  {key:'total',label:'累計開票未稅',kind:'num',value:r=>r.total,filter:'none',render:r=><>{fmt(r.total)}{r.unknown>0&&<small className="amber-text">{r.unknown} 張金額待補</small>}</>},
  {key:'share',label:'占比',kind:'num',value:r=>r.share,exportValue:r=>r.share*100,format:PERCENT,filter:'none',render:r=>pct(r.share)},
  ...v.years.map(y=>({key:`y${y}`,label:`${y} 年`,kind:'num' as const,value:(r:ClientRow)=>r.byYear[y]??null,filter:'none' as const,render:(r:ClientRow)=>r.yearUnknown[y]?<>{r.byYear[y]?fmt(r.byYear[y]):''}<small className="amber-text">{r.yearUnknown[y]} 張金額待補</small></>:fmt(r.byYear[y]??null)})),
  {key:'cases',label:'開票案件數',kind:'num',value:r=>r.cases,filter:'none'},
  {key:'average',label:'平均案額',kind:'num',value:r=>r.average,filter:'none',render:r=>r.average===null&&r.unknown?<span className="muted">待補</span>:fmt(r.average)},
  {key:'ac',label:'毛利（AC 費）',kind:'num',value:r=>r.acFee,filter:'none',render:r=>r.acFee===null?<span className="muted">待補</span>:<>{fmt(r.acFee)}<small className="muted">{r.acCases} 案</small></>},
  {key:'win',label:'成交率',kind:'num',value:r=>r.winRate,exportValue:r=>r.winRate===null?null:r.winRate*100,format:PERCENT,filter:'none',render:r=>r.winRate===null?'—':<>{pct(r.winRate)}<small className="muted">{r.won}／{r.originals} 案</small></>},
  {key:'last',label:'最後開票日',kind:'date',value:r=>r.lastDate,filter:'text'},
  {key:'since',label:'距今天數',kind:'num',value:r=>r.daysSince,filter:'none',render:r=>r.daysSince===null?'—':<span className={r.dormant?'amber-text':''}>{r.daysSince} 天</span>},
 ];
 return <><KpiCards className="page-kpis" label="依客戶狀態篩選" value={view} onChange={setView} items={[
  {key:'all',label:'合作客戶',value:t.count,unit:'家',note:`累計開票未稅 ${knownNote(t.total,t.unknown,'張')}`},
  {key:'active',label:`${today.slice(0,4)} 年有開票`,value:t.active,unit:'家',note:'今年仍在合作的客戶'},
  {key:'dormant',label:'超過半年未合作',value:t.dormant,unit:'家',note:`最後開票距今超過 ${DORMANT_DAYS} 天 · 值得再聯繫`},
  {key:'top',label:'前三大客戶占比',value:pct(t.top3Share),note:'占累計開票未稅 · 占比越高越依賴少數客戶'},
 ]}/><div className="notice soft"><Info size={17}/><p>這一頁統計所有年度，不受上方期間篩選影響。成交率＝已成交原案 ÷ 全部原案（追加不重複計算）；毛利只計入已填服務費率的報價。</p></div><section className="panel"><PanelTitle title="客戶一覽" sub="依累計開票金額排序 · 點選列查看該客戶的案件"/>{!v.rows.length?<Empty/>:<DataTable rows={shown} columns={columns} rowKey={r=>r.clientId} onRowClick={r=>pick(r.clientId)} fileName="客戶分析" empty="沒有符合的客戶"/>}</section></>;
}
function Followups({rows,data,select}:{rows:ReturnType<typeof followupView>;data:Dataset;select:(id:string)=>void}){
 const [view,setView]=useState<FollowView>('all');const t=rows.totals;
 const clientName=(r:FollowRow)=>text(data.clients.find(x=>x.id===r.clientId)?.name)||'待確認';
 const shown=view==='all'?rows.rows:view==='due'?rows.rows.filter(r=>r.due):rows.rows.filter(r=>r.bucket===view);
 const columns:Column<FollowRow>[]=[
  {key:'number',label:'案號',value:r=>r.number,filter:'text',width:'96px',render:r=><span className="case-number">{r.number}{r.addition&&<span className="addition-label">追加</span>}</span>},
  {key:'title',label:'案名',value:r=>r.title||'未命名案件',filter:'text',render:r=><strong className="cell-strong">{r.title||'未命名案件'}</strong>},
  {key:'client',label:'付款公司',value:clientName,filter:'select'},
  {key:'quoteDate',label:'最新報價日',kind:'date',value:r=>r.quoteDate,filter:'text'},
  {key:'days',label:'已報價天數',kind:'num',value:r=>r.days,filter:'none',render:r=>r.days===null?<span className="muted">{r.hasQuote?'報價日待補':'尚未報價'}</span>:<span className={r.bucket==='stale'?'amber-text':''}>{r.days} 天</span>},
  {key:'net',label:'報價未稅',kind:'num',value:r=>r.net,filter:'none'},
  {key:'ac',label:'毛利（AC 費）',kind:'num',value:r=>r.acFee,filter:'none'},
  {key:'next',label:'下次追案日',kind:'date',value:r=>r.next,filter:'text',render:r=>r.next?<Badge tone={r.due?'amber':'neutral'}>{r.next}{r.due?' · 該追了':''}</Badge>:<span className="muted">未排</span>},
  {key:'action',label:'下一步',value:r=>r.nextAction,filter:'text',render:r=><span className="cell-wrap">{r.nextAction||'—'}</span>},
  {key:'last',label:'最後聯繫日',kind:'date',value:r=>r.lastContact,filter:'text'},
 ];
 return <><KpiCards className="page-kpis" label="依追案狀態篩選" value={view} onChange={setView} items={[
  {key:'all',label:'待客戶決定',value:t.all.count,unit:'案',note:`報價未稅 ${knownNote(t.all.net,t.all.unknown,'案')}${t.noquote.count?` · ${t.noquote.count} 案尚未報價`:''}`},
  {key:'due',label:'今天該追',value:t.due.count,unit:'案',note:'「下次追案日」已到或已過'},
  {key:'fresh',label:'報價 30 天內',value:t.fresh.count,unit:'案',note:`${knownNote(t.fresh.net,t.fresh.unknown,'案')} · 成交機會最高`},
  {key:'mid',label:'報價 31–90 天',value:t.mid.count,unit:'案',note:`${knownNote(t.mid.net,t.mid.unknown,'案')} · 建議再確認一次`},
  {key:'stale',label:'超過 90 天',value:t.stale.count,unit:'案',note:`${knownNote(t.stale.net,t.stale.unknown,'案')} · 沒下文可改為未成交`},
 ]}/><div className="notice soft"><Info size={17}/><p>在試算表「案件商機」分頁填「下次追案日」和「下一步」，到期當天會出現在「今天該追」。沒有下文的案件把「商機狀態」改為「未成交」，就會離開這張清單。</p></div><section className="panel"><PanelTitle title="追案清單" sub="尚未成交也未標記未成交的案件 · 該追的排最前，其餘依報價日由新到舊"/>{!rows.rows.length?<Empty title="目前沒有待追的案件"/>:<DataTable rows={shown} columns={columns} rowKey={r=>r.caseId} onRowClick={r=>select(r.caseId)} fileName="追案清單" empty="沒有符合的案件"/>}</section></>;
}
const ISSUE_LABEL:Record<string,string>={relationship:'案件關聯',quote_versions:'有效版本衝突',allocation:'收款分配',duplicate_invoice:'重複發票',duplicate_invoice_id:'發票識別碼重複',latest_quote:'最新報價待核對',import_review:'自動匯入待核對',resign:'改版待簽回',sale_date:'成交日期',won_evidence:'成交依據不足',invalid_value:'欄位值無法辨識',quote_reference:'報價未連結案件',case_reference:'發票未連結案件'};
function Review({a,data,select}:{a:Analysis;data:Dataset;select:(id:string)=>void}){
 const records=[...a.reconciliation.map(r=>({id:text(r.id),caseId:text(r.caseId),type:text(r.type),description:text(r.description),sourceId:text(r.sourceId)})),...a.issues.map((i,index)=>({...i,caseId:text(i.caseId),id:`derived-${index}`,sourceId:''}))].map(r=>({...r,label:ISSUE_LABEL[r.type]??r.type,origin:r.id.startsWith('derived-')?'系統檢查':'資料表待核對事項'}));
 const groups=[...records.reduce((m,r)=>m.set(r.label,(m.get(r.label)??0)+1),new Map<string,number>())].sort((x,y)=>y[1]-x[1]);
 const [cat,setCat]=useState<string>('all');
 const shown=cat==='all'?records:records.filter(r=>r.label===cat);
 const byCase=new Map(a.cases.map(c=>[c.id,c]));
 const columns:Column<typeof records[number]>[]=[
  {key:'label',label:'類別',value:r=>r.label,filter:'select',render:r=><Badge tone="amber">{r.label}</Badge>},
  {key:'case',label:'案號',value:r=>text(byCase.get(r.caseId)?.number),filter:'text',width:'96px'},
  {key:'description',label:'需要確認的內容',value:r=>r.description,filter:'text',render:r=><span className="cell-wrap">{r.description}</span>},
  {key:'origin',label:'來源',value:r=>r.origin,filter:'select'},
  {key:'doc',label:'文件',value:r=>r.sourceId?'有':'',filter:'none',render:r=>r.sourceId?<SourceLink url={data.documents.find(d=>d.id===r.sourceId)?.url}>開啟</SourceLink>:<span className="muted">—</span>},
 ];
 return <section className="panel"><PanelTitle title="需要確認的紀錄" sub={`${records.length} 項，依類別分組 · 在資料表補上處理結果並把核對狀態改為「已處理」`}/>
  {!records.length?<Empty title="目前沒有待核對項目" description="仍請留意來源涵蓋範圍，空白金額不代表零。"/>:<>
  <KpiCards className="review-kpis" label="依類別篩選" value={cat} onChange={setCat} items={[{key:'all',label:'全部',value:records.length,unit:'項'},...groups.map(([g,n])=>({key:g,label:g,value:n,unit:'項'}))]}/>
  <DataTable rows={shown} columns={columns} rowKey={r=>r.id} onRowClick={r=>{if(byCase.has(r.caseId))select(r.caseId);}} fileName={`資料待核對${cat==='all'?'':'-'+cat}`}/></>}
 </section>;
}
function CaseDrawer({c,data,close}:{c:DerivedCase;data:Dataset;close:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();},[]);const quotes=data.quotes.filter(q=>q.caseId===c.id);const invoices=data.invoices.filter(i=>i.caseId===c.id);const client=data.clients.find(r=>r.id===c.clientId);
 return <dialog ref={dialog} className="case-dialog" onCancel={close} onClick={e=>{if(e.target===dialog.current)close();}}><div className="drawer"><div className="drawer-top"><span className="eyebrow">CASE DETAIL / 案件檔案</span><button className="icon-button" aria-label="關閉案件明細" onClick={close}><X size={20}/></button></div><div className="drawer-heading"><span className="case-number">{text(c.number)}{c.parentId&&<span className="addition-label">追加案</span>}</span><h2>{text(c.title)||'未命名案件'}</h2><div><Badge tone={c.won?'green':'amber'}>{c.derivedStatus}</Badge><Badge>{c.historical?'歷史匯入':'新案件'}</Badge>{!c.certified&&<Badge tone="amber">關聯待確認</Badge>}</div></div><div className="drawer-stats"><div><span>成交未稅（有效發票合計）</span><strong>{c.saleNet===null?'待確認':`NT$ ${fmt(c.saleNet)}`}</strong></div><div><span>目前進度</span><StageStepper c={c}/></div></div><dl className="detail-grid"><div><dt>付款公司</dt><dd>{text(client?.name)||'待確認'}</dd></div><div><dt>統一編號</dt><dd>{text(client?.taxId)||'待確認'}</dd></div><div><dt>活動品牌</dt><dd>{text(c.brand)||'尚未填寫'}</dd></div><div><dt>執行狀態</dt><dd>{text(c.executionStatus)||'待確認'}</dd></div><div><dt>{c.historical?'成交認定日（歷史發票）':'簽回成交日'}</dt><dd>{dateLabel(c.saleDate)}</dd></div><div><dt>活動期間</dt><dd>{dateLabel(c.activityStart)}<br/>{parseDate(c.activityEnd)?`至 ${dateLabel(c.activityEnd)}`:''}</dd></div><div><dt>最新改版簽回日</dt><dd>{dateLabel(c.revisionSignedDate)}</dd></div><div><dt>最新改版簽回文件</dt><dd><SourceLink url={data.documents.find(d=>d.id===c.revisionSignedSourceId)?.url}>改版簽回證據</SourceLink></dd></div><div><dt>下一次追案</dt><dd>{dateLabel(c.nextFollowupDate)}</dd></div><div><dt>下一步</dt><dd>{text(c.nextAction)||'尚未安排'}</dd></div></dl>{c.signedSourceId&&<div className="drawer-signature"><ShieldCheck size={17}/><SourceLink url={data.documents.find(d=>d.id===c.signedSourceId)?.url}>原成交簽回文件</SourceLink></div>}
 <section className="drawer-section"><h3><Layers size={16}/>報價版本 <span>{quotes.length}</span></h3>{!quotes.length?<p className="muted">尚無報價文件；成交金額依有效發票未稅合計。</p>:quotes.map(q=><details className="quote-detail" key={text(q.id)}><summary><div><strong>{text(q.title)||'報價單'}</strong><small>{parseDate(q.date)??'日期待確認'} · {text(q.version)||'版本未註明'} · {text(q.role)||'範圍待確認'}</small></div><Badge tone={yes(q.effective)?'green':'neutral'}>{yes(q.effective)?'有效':'留存'}</Badge></summary><div className="quote-detail-body"><div className="amount-line"><span>未稅 / 含稅</span><b>{fmt(money(q.net))} / {fmt(money(q.gross))}</b></div>{acFee(q)!==null&&<div className="amount-line"><span>AC 費（毛利）</span><b>{fmt(acFee(q))}</b></div>}{money(q.specialGross)!==null&&<div className="amount-line"><span>專案優惠含稅</span><b>{fmt(money(q.specialGross))}</b></div>}<SourceLink url={data.documents.find(d=>d.id===q.sourceId)?.url}>開啟原始報價</SourceLink><div className="quote-items">{data.quoteItems.filter(item=>item.quoteId===q.id).map(item=><div key={text(item.id)}><span>{text(item.description)}<small>{text(item.spec)} · {text(item.quantity)} {text(item.unit)}</small></span><b>{fmt(money(item.amount,true))}</b></div>)}</div>{q.terms&&<p className="preserve-whitespace">{text(q.terms)}</p>}{q.notes&&<p className="muted">{text(q.notes)}</p>}</div></details>)}</section>
 <section className="drawer-section"><h3><FileText size={16}/>發票紀錄 <span>{invoices.length}</span></h3>{!invoices.length?<p className="muted">尚無發票紀錄。</p>:invoices.map(i=><div className="invoice-detail" key={text(i.id)}><div><strong>{text(i.number)}</strong><small>{parseDate(i.date)??'日期待確認'} · {text(i.status)}</small><SourceLink url={data.documents.find(d=>d.id===i.sourceId)?.url}>原始文件</SourceLink></div><b>NT$ {fmt(money(i.gross))}<small>含稅</small></b></div>)}</section>{c.notes&&<section className="drawer-section"><h3>案件備註</h3><p className="preserve-whitespace muted">{text(c.notes)}</p></section>}<p className="drawer-footnote">此處僅供檢視。需要調整資料時，請回到 Google Sheets，保留原始版本與處理紀錄。</p></div></dialog>;
}
function Loading(){return <div aria-busy="true" aria-label="正在讀取營運資料"><div className="metrics skeletons">{[1,2,3,4].map(i=><div className="metric-card" key={i}><i/><b/><i/></div>)}</div><div className="dashboard-grid skeletons"><div className="panel skeleton-chart"/><div className="panel skeleton-chart"/></div></div>;}
function PeriodPicker({kind,anchor,years,onChange}:{kind:string;anchor:string;years:number[];onChange:(v:string)=>void}){
 const y=Number(anchor.slice(0,4));const m=Number(anchor.slice(5,7));const list=years.includes(y)?years:[...years,y].sort((a,b)=>b-a);
 const set=(year:number,month:number)=>onChange(`${year}-${String(month).padStart(2,'0')}-01`);
 return <><select aria-label="選擇年度" value={y} onChange={e=>set(Number(e.target.value),m)}>{list.map(v=><option key={v} value={v}>{v} 年</option>)}</select>
  {kind==='month'&&<select aria-label="選擇月份" value={m} onChange={e=>set(y,Number(e.target.value))}>{Array.from({length:12},(_,i)=><option key={i} value={i+1}>{i+1} 月</option>)}</select>}
  {kind==='quarter'&&<select aria-label="選擇季度" value={Math.floor((m-1)/3)} onChange={e=>set(y,Number(e.target.value)*3+1)}>{[0,1,2,3].map(q=><option key={q} value={q}>第 {q+1} 季</option>)}</select>}</>;
}
