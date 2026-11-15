import {StrictMode,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Dashboard,{type DashboardAccount} from '@/components/dashboard';
import {loadForAccount} from '@/lib/pages/google-sheets';
import {clearSession,lastEmail,readSession,saveSession} from '@/lib/pages/session';
import sourceTarget from '@/lib/server/source-target.json';
import config from './config.json';
import '../app/globals.css';

declare const google:any;
const SHEETS_SCOPE='https://www.googleapis.com/auth/spreadsheets.readonly';
const SCOPE=`openid email ${SHEETS_SCOPE}`;
const spreadsheetUrl=sourceTarget.spreadsheetUrl;

function waitForGoogle(){return new Promise<void>((resolve,reject)=>{const start=Date.now();const tick=()=>{if(typeof google!=='undefined'&&google.accounts?.oauth2)resolve();else if(Date.now()-start>15000)reject(Error('Google 登入元件載入失敗'));else setTimeout(tick,100);};tick();});}

function App(){
 // Restore a still-valid sign-in so a reload does not ask again.
 const [session,setSession]=useState<{token:string;email:string;expiresAt:number}|null>(()=>readSession());
 const needConsent=useRef(false);
 const [problem,setProblem]=useState<string|null>(config.googleClientId?null:'網站尚未設定 Google OAuth Client ID（gh-pages/config.json）。');
 const client=useRef<any>(null);
 useEffect(()=>{
  if(!config.googleClientId)return;
  waitForGoogle().then(()=>{
   client.current=google.accounts.oauth2.initTokenClient({client_id:config.googleClientId,scope:SCOPE,callback:async(r:any)=>{
    if(r.error){setProblem(r.error==='popup_closed'?null:`Google 登入未完成：${r.error}`);return;}
    if(!google.accounts.oauth2.hasGrantedAllScopes(r,SHEETS_SCOPE)){needConsent.current=true;setProblem('登入時沒有勾選「查看 Google 試算表」權限，網站無法讀取資料；請再按一次登入並勾選該項目。');return;}
    try{
     const info:any=await (await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${r.access_token}`}})).json();
     if(!info.email||info.email_verified===false)throw Error();
     needConsent.current=false;setProblem(null);setSession(saveSession(r.access_token,String(info.email).toLowerCase(),Number(r.expires_in)||3600));
    }catch{setProblem('無法取得 Google 帳號 Email，請重新登入。');}
   }});
  }).catch(e=>setProblem(e.message));
 },[]);
 // Returning visitors: hint the last account and skip prompts Google can answer silently.
 const signIn=useCallback(()=>{
  if(!client.current){setProblem(p=>p??'Google 登入元件尚未載入，請稍候再試。');return;}
  const hint=lastEmail();
  client.current.requestAccessToken(needConsent.current?{prompt:'consent',login_hint:hint??undefined}:hint?{prompt:'',login_hint:hint}:{prompt:'select_account'});
 },[]);
 const signOut=useCallback(()=>{if(session&&typeof google!=='undefined')google.accounts.oauth2.revoke(session.token,()=>{});clearSession(true);setSession(null);},[session]);
 const loadData=useCallback(async()=>{
  if(!session)return{status:'authentication_required',message:'請先登入。'};
  const result=await loadForAccount(session.token,sourceTarget);
  // Expired or revoked token: drop it and show the one-click sign-in again.
  if(result.status==='reauthentication_required'){clearSession();setSession(null);setProblem('登入已過期，請按「使用 Google 帳號登入」繼續（通常不必重新選帳號）。');}
  return result;
 },[session]);
 const account=useMemo<DashboardAccount|null>(()=>session?{email:session.email,spreadsheetUrl,onSignOut:signOut}:null,[session,signOut]);
 return <>
  <Dashboard notice={config.googleClientId?problem:null} signInDisabledReason={config.googleClientId?null:'Google 登入尚未啟用：網站管理者需先建立 Google OAuth 用戶端 ID，並填入 gh-pages/config.json。'} key={session?.email??'anon'} signedIn={!!session} loadData={session?loadData:undefined} onSignIn={signIn} signInLabel="使用 Google 帳號登入" account={account}/>
 </>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
