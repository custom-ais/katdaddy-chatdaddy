import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createOwnerConsent} from '../server/owner-consent.mjs';
import {createAdminAuth} from '../server/admin-auth.mjs';
import {OWNER_SMS_CONSENT_VERSION,OWNER_SMS_DISCLOSURE} from '../shared/owner-sms-consent.mjs';
import {harness,contact} from './helpers.mjs';
const phone='6235550100';
const grant=(revision=0)=>({action:'grant',revision,phone,consent:true,disclosureVersion:OWNER_SMS_CONSENT_VERSION,idempotencyKey:randomUUID()});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} receipts require explicit consent, saved recipient and authenticated actor, never activate settings or send`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}});const module=createOwnerConsent({store:h.store});
 for(const bad of [null,[],false,{...grant(),idempotencyKey:'-'.repeat(36)}])await assert.rejects(module.record(bad,'admin'),{status:400});
 assert.equal((await module.snapshot()).current,null);assert.equal(await module.allows(phone),true);
 await assert.rejects(module.record({...grant(),consent:false},'admin'));await assert.rejects(module.record({...grant(),phone:'6235550199'},'admin'));await assert.rejects(module.record(grant(),''));
 const body=grant();const first=await module.record(body,'admin-session-private');assert.equal(first.receipt.active,true);assert.equal(first.receipt.phone,'+16235550100');assert.equal(first.receipt.disclosure,OWNER_SMS_DISCLOSURE);assert.equal(first.receipt.disclosureVersion,OWNER_SMS_CONSENT_VERSION);assert.equal(first.effectiveActive,false);assert.equal(first.receipt.sendingAuthorized,false);assert.equal(await module.allows(phone),false);assert.notEqual(first.receipt.actor.reference,'admin-session-private');
 assert.deepEqual((await module.record(body,'admin-session-private')).receipt,first.receipt);assert.equal((await h.store.config()).bookingOwnerSmsEnabled,false);assert.equal(h.twilio.calls.length,0);
 const rows=await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'");assert.equal(rows.length,1);
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} concurrent grants serialize by revision and append receipts; revocation is durable and number-bound`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}});const module=createOwnerConsent({store:h.store});
 const result=await Promise.allSettled([module.record(grant(),'a'),module.record(grant(),'b')]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.status,409);
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,1,'losing revision must not append a receipt');
 const first=(await module.snapshot()).current;
 await module.record({action:'revoke',revision:1,idempotencyKey:randomUUID()},'a');assert.equal(await module.allows(phone),false);assert.equal(await module.allows('6235550199'),false);
 const history=await h.db.query("select value from bob.kv where key like 'owner-sms-consent:receipt:%'");assert.equal(history.length,2);assert.ok(history.some(r=>r.value.id===first.id&&r.value.active===true));
 await assert.rejects(module.record(grant(1),'a'),{status:409});
 await module.record({...grant(2),sendingAuthorized:true},'a');assert.equal(await module.allows(phone),false,'consent or regrant never activates the legacy sender');assert.equal((await module.snapshot()).current.sendingAuthorized,false);assert.equal(await module.allows('6235550199'),false);
 const c=await h.store.config();await h.store.set('config',{...c,bookingOwnerSmsPhone:'6235550199'});assert.equal((await module.snapshot()).effectiveActive,false);assert.equal(await module.allows(phone),false,'old phone must not be authorized after configured recipient changes');
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} consent API requires named Master Admin and does not mistake legacy toggle for consent`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone,bookingOwnerSmsEnabled:true}});
 assert.equal((await h.call('/api/admin/owner-sms-consent')).status,401);
 const legacy=await h.login();
 assert.equal((await h.call('/api/admin/owner-sms-consent',{cookie:legacy})).status,403);
 assert.equal((await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie:legacy,body:grant()})).status,403);
 assert.equal(await h.store.kvGet('owner-sms-consent:current'),null);
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,0);
 assert.equal((await h.store.config()).bookingOwnerSmsEnabled,true,'denial must not change existing alert switches');
 assert.equal(h.twilio.calls.length,0);
 const auth=createAdminAuth({store:h.store,clock:h.store.clock});
 const owner=await auth.prepareOwnerBootstrap({email:'owner-consent@example.test',name:'Synthetic Consent Owner'});
 const password='Synthetic-consent-owner-password-2026';
 assert.equal((await h.call('/api/admin/owner-bootstrap/accept',{method:'POST',body:{token:owner.token,password}})).status,200);
 const login=await h.call('/api/admin/login',{method:'POST',body:{email:'owner-consent@example.test',password}});
 assert.equal(login.status,200);assert.equal(login.data.pendingCutover,true);
 assert.equal((await h.call('/api/admin/owner-sms-consent',{cookie:legacy})).status,403,'claiming an owner does not authorize shared sessions');
 await auth.activateNamedMode({ownerId:owner.user.id});
 const cookie=login.cookie;
 const before=await h.call('/api/admin/owner-sms-consent',{cookie});assert.equal(before.status,200);assert.equal(before.data.current,null);assert.equal(before.data.effectiveActive,false);assert.equal(before.data.readiness.stopHelpVerified,false);
 const body=grant();assert.equal((await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie,body,headers:{origin:'https://foreign.example'}})).status,403);
 const saved=await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie,body});assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.equal(saved.data.receipt.actor.type,'authenticated_admin_user');assert.equal(saved.data.receipt.actor.userId,owner.user.id);assert.equal(saved.data.receipt.sendingAuthorized,false);
 const revoked=await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie,body:{action:'revoke',revision:1,idempotencyKey:randomUUID()}});assert.equal(revoked.status,200);
 const booked=await h.book('cleaning',{...contact,smsConsent:false});assert.equal(booked.status,201);assert.equal(h.twilio.calls.filter(c=>c[0]==='sms').length,0,'revocation gates existing booking alerts');
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} revocation during booking alert claim suppresses the actual send without undoing booking`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone,bookingOwnerSmsEnabled:true}});const module=createOwnerConsent({store:h.store});
 const query=h.store.db.query;let revoked=false;h.store.db.query=async(sql,args)=>{const rows=await query(sql,args);if(!revoked&&String(args?.[0]).startsWith('owner-booking-sms:')){revoked=true;await module.record(grant(),'admin');await module.record({action:'revoke',revision:1,idempotencyKey:randomUUID()},'admin');}return rows;};
 const booked=await h.book('cleaning',{...contact,smsConsent:false});assert.equal(booked.status,201);assert.equal(revoked,true);assert.equal(h.twilio.calls.filter(c=>c[0]==='sms').length,0);assert.equal((await h.store.appointments())[0].status,'confirmed');
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} concurrent retries with identical request key append only one immutable receipt`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}});const module=createOwnerConsent({store:h.store});const body=grant();
 const results=await Promise.all([module.record(body,'admin'),module.record(body,'admin')]);assert.equal(results[0].receipt.id,results[1].receipt.id);
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,1);
 assert.equal((await module.snapshot()).revision,1);assert.deepEqual((await module.snapshot()).current,results[0].receipt);
 await assert.rejects(module.record({...body,action:'revoke'},'admin'),{status:409});
 assert.deepEqual((await module.snapshot()).current,results[0].receipt,'different-fingerprint key reuse cannot alter the accepted receipt');
});

for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} a failed atomic revision comparison does not append a losing receipt`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}}),module=createOwnerConsent({store:h.store});
 await module.record(grant(),'admin');
 const query=h.db.query;let inject=true,winner;
 h.db.query=async(sql,args)=>{
  if(inject&&/^do\s/i.test(sql)){inject=false;winner=await module.record(grant(1),'other-admin');}
  return query(sql,args);
 };
 try{await assert.rejects(module.record(grant(1),'admin'),{status:409});}finally{h.db.query=query;}
 assert.equal(inject,false);assert.deepEqual((await module.snapshot()).current,winner.receipt);
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,2);
 assert.equal((await module.snapshot()).revision,2);assert.equal(await module.allows(phone),false);
});

for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} receipt key conflict rolls back the tentative current-receipt change`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}}),module=createOwnerConsent({store:h.store});
 const first=await module.record(grant(),'admin'),body=grant(1);
 const key='owner-sms-consent:receipt:'+createHash('sha256').update(body.idempotencyKey).digest('hex');
 const immutable={...first.receipt,id:randomUUID(),requestFingerprint:'synthetic-conflicting-request'};
 const query=h.db.query;let inject=true;
 h.db.query=async(sql,args)=>{
  if(inject&&/^do\s/i.test(sql)){inject=false;await query('insert into bob.kv(key,value,expires) values($1,$2::jsonb,null)',[key,JSON.stringify(immutable)]);}
  return query(sql,args);
 };
 try{await assert.rejects(module.record(body,'admin'),{status:409});}finally{h.db.query=query;}
 assert.equal(inject,false);assert.deepEqual((await module.snapshot()).current,first.receipt,'failed receipt insertion must undo current update');
 assert.deepEqual(await h.store.kvGet(key),immutable,'conflicting append-only receipt must not be overwritten');
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,2);
});

for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} lost write response after commit returns the stored receipt and replay stays idempotent`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}}),module=createOwnerConsent({store:h.store}),body=grant();
 const query=h.db.query;let interrupted=false;
 h.db.query=async(sql,args)=>{
  const rows=await query(sql,args);
  if(!interrupted&&/^do\s/i.test(sql)){interrupted=true;throw new Error('Synthetic response loss after the database committed.');}
  return rows;
 };
 let saved;try{saved=await module.record(body,'admin');}finally{h.db.query=query;}
 assert.equal(interrupted,true);const replay=await module.record(body,'admin');assert.deepEqual(replay.receipt,saved.receipt);
 assert.deepEqual((await module.snapshot()).current,saved.receipt);assert.equal((await module.snapshot()).revision,1);
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,1);
 assert.equal((await module.snapshot()).sendingAuthorized,false);assert.equal(h.twilio.calls.length,0);
});
