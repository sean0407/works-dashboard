import test from 'node:test';
import assert from 'node:assert/strict';
import {clearSession,lastEmail,readSession,saveSession} from '../lib/pages/session.ts';

const memory=()=>{const m=new Map();return{getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),m};};

test('a saved sign-in survives reload until shortly before expiry',()=>{
 const s=memory();const now=1_000_000;
 saveSession('tok','a@x.com',3600,now,s);
 assert.deepEqual(readSession(now+30*60_000,s),{token:'tok',email:'a@x.com',expiresAt:now+3_600_000});
 assert.equal(readSession(now+3_600_000-30_000,s),null);
 assert.equal(s.getItem('works-dashboard.session'),null);
 assert.equal(lastEmail(s),'a@x.com');
});

test('sign-out forgets the token and, when asked, the account hint',()=>{
 const s=memory();saveSession('tok','a@x.com',3600,0,s);
 clearSession(false,s);assert.equal(readSession(0,s),null);assert.equal(lastEmail(s),'a@x.com');
 clearSession(true,s);assert.equal(lastEmail(s),null);
});

test('corrupt or missing storage never breaks the page',()=>{
 const s=memory();s.setItem('works-dashboard.session','{not json');
 assert.equal(readSession(0,s),null);
 assert.equal(readSession(0,null),null);
 const throwing={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};
 assert.equal(readSession(0,throwing),null);
 assert.doesNotThrow(()=>saveSession('t','a@x.com',3600,0,throwing));
 assert.doesNotThrow(()=>clearSession(true,throwing));
 assert.equal(lastEmail(throwing),null);
});
