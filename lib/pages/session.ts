/**
 * Keeps the Google access token across page reloads until it expires (Google issues ~1 hour tokens).
 * Browser-only convenience: a browser without storage simply asks the visitor to sign in again.
 */
export type StoredSession={token:string;email:string;expiresAt:number};
const SESSION_KEY='works-dashboard.session';
const HINT_KEY='works-dashboard.lastEmail';
const SAFETY_MS=60_000;

type Storage={getItem(k:string):string|null;setItem(k:string,v:string):void;removeItem(k:string):void};
const store=():Storage|null=>{try{return typeof localStorage==='undefined'?null:localStorage;}catch{return null;}};

export function readSession(now=Date.now(),s:Storage|null=store()):StoredSession|null{
 try{
  const raw=s?.getItem(SESSION_KEY);if(!raw)return null;
  const v=JSON.parse(raw);
  if(typeof v?.token!=='string'||typeof v?.email!=='string'||typeof v?.expiresAt!=='number')return null;
  if(v.expiresAt-SAFETY_MS<=now){s?.removeItem(SESSION_KEY);return null;}
  return v;
 }catch{return null;}
}
export function saveSession(token:string,email:string,expiresInSeconds:number,now=Date.now(),s:Storage|null=store()):StoredSession{
 const session={token,email,expiresAt:now+Math.max(0,expiresInSeconds)*1000};
 try{s?.setItem(SESSION_KEY,JSON.stringify(session));s?.setItem(HINT_KEY,email);}catch{}
 return session;
}
export function clearSession(forgetAccount=false,s:Storage|null=store()){
 try{s?.removeItem(SESSION_KEY);if(forgetAccount)s?.removeItem(HINT_KEY);}catch{}
}
/** Last signed-in account, used as login_hint so re-login skips the account chooser. */
export function lastEmail(s:Storage|null=store()):string|null{try{return s?.getItem(HINT_KEY)||null;}catch{return null;}}
