import {StrictMode,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Dashboard,{type DashboardAccount} from '@/components/dashboard';
import {loadForAccount} from '@/lib/pages/google-sheets';
import sourceTarget from '@/lib/server/source-target.json';
import config from './config.json';
import '../app/globals.css';

declare const google:any;
const SCOPE='openid email https://www.googleapis.com/auth/spreadsheets.readonly';
const spreadsheetUrl=sourceTarget.spreadsheetUrl;

function waitForGoogle(){return new Promise<void>((resolve,reject)=>{const start=Date.now();const tick=()=>{if(typeof google!=='undefined'&&google.accounts?.oauth2)resolve();else if(Date.now()-start>15000)reject(Error('Google 登入元件載入失敗'));else setTimeout(tick,100);};tick();});}

function App(){
 const [session,setSession]=useState<{token:string;email:string}|null>(null);
 const [allowed,setAllowed]=useState<string[]|null>(null);
 const [problem,setProblem]=useState<string|null>(config.googleClientId?null:'網站尚未設定 Google OAuth Client ID（pages/config.json）。');
 const client=useRef<any>(null);
 useEffect(()=>{
  if(!config.googleClientId)return;
  waitForGoogle().then(()=>{
   client.current=google.accounts.oauth2.initTokenClient({client_id:config.googleClientId,scope:SCOPE,callback:async(r:any)=>{
    if(r.error){setProblem(`Google 登入未完成：${r.error}`);return;}
    try{
     const info:any=await (await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${r.access_token}`}})).json();
     if(!info.email||info.email_verified===false)throw Error();
     setProblem(null);setSession({token:r.access_token,email:String(info.email).toLowerCase()});
    }catch{setProblem('無法取得 Google 帳號 Email，請重新登入。');}
   }});
  }).catch(e=>setProblem(e.message));
 },[]);
 const signIn=useCallback(()=>{if(client.current)client.current.requestAccessToken({prompt:session?'':'select_account'});else setProblem(p=>p??'Google 登入元件尚未載入，請稍候再試。');},[session]);
 const signOut=useCallback(()=>{if(session)google.accounts.oauth2.revoke(session.token,()=>{});setSession(null);setAllowed(null);},[session]);
 const loadData=useCallback(async()=>{
  if(!session)return{status:'authentication_required',message:'請先登入。'};
  const result=await loadForAccount(session.token,session.email,sourceTarget);
  setAllowed(result.allowedEmails??null);
  return result;
 },[session]);
 const account=useMemo<DashboardAccount|null>(()=>session?{email:session.email,allowedEmails:allowed,spreadsheetUrl,onSignOut:signOut}:null,[session,allowed,signOut]);
 return <>
  <Dashboard notice={problem} key={session?.email??'anon'} signedIn={!!session} loadData={session?loadData:undefined} onSignIn={signIn} signInLabel="使用 Google 帳號登入" account={account}/>
 </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
