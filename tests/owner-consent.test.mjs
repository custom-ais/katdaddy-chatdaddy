import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createOwnerConsent} from '../server/owner-consent.mjs';
import {createAdminAuth} from '../server/admin-auth.mjs';
import {OWNER_SMS_CONSENT_VERSION,OWNER_SMS_DISCLOSURE,OWNER_SMS_PURPOSES,OWNER_SMS_TERMS_URL,OWNER_SMS_PRIVACY_URL} from '../shared/owner-sms-consent.mjs';
import {harness,contact} from './helpers.mjs';
const phone='6235550100';
const grant=(revision=0)=>({action:'grant',revision,phone,consent:true,disclosureVersion:OWNER_SMS_CONSENT_VERSION,idempotencyKey:randomUUID()});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} receipts require explicit consent, saved recipient and authenticated actor, never activate settings or send`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}});const module=createOwnerConsent({store:h.store});
 for(const bad of [null,[],false,{...grant(),idempotencyKey:'-'.repeat(36)}])await assert.rejects(module.record(bad,'admin'),{status:400});
 assert.deepEqual(await module.snapshot(),{revision:0,current:null,matchesConfiguredPhone:false,currentVersion:false,effectiveActive:false,covers:[],disclosure:{version:OWNER_SMS_CONSENT_VERSION,text:OWNER_SMS_DISCLOSURE,purposes:[...OWNER_SMS_PURPOSES],termsUrl:OWNER_SMS_TERMS_URL,privacyUrl:OWNER_SMS_PRIVACY_URL}});assert.equal(await module.allows(phone),false);
 await assert.rejects(module.record({...grant(),consent:false},'admin'));await assert.rejects(module.record({...grant(),phone:'6235550199'},'admin'));await assert.rejects(module.record({...grant(),disclosureVersion:'custom-ais-owner-transactional-v1'},'admin'),{status:400});await assert.rejects(module.record(grant(),''));
 const body=grant();const first=await module.record(body,'admin-session-private');assert.equal(first.receipt.active,true);assert.equal(first.receipt.phone,'+16235550100');assert.equal(first.receipt.disclosure,OWNER_SMS_DISCLOSURE);assert.equal(first.receipt.disclosureVersion,OWNER_SMS_CONSENT_VERSION);assert.equal(first.effectiveActive,true);assert.equal(first.currentVersion,true);assert.equal(Object.hasOwn(first.receipt,'sendingAuthorized'),false);assert.equal(Object.hasOwn(first,'sendingAuthorized'),false);assert.equal(Object.hasOwn(first,'readiness'),false);assert.equal(await module.allows(phone),true);assert.notEqual(first.receipt.actor.reference,'admin-session-private');
 assert.deepEqual((await module.record(body,'admin-session-private')).receipt,first.receipt);assert.equal((await h.store.config()).bookingOwnerSmsEnabled,false);assert.equal(h.twilio.calls.length,0);
 const rows=await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'");assert.equal(rows.length,1);
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} v1 receipts remain immutable and cannot authorize sending; v2 requires a new explicit grant`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone,bookingOwnerSmsEnabled:true}}),module=createOwnerConsent({store:h.store});
 const oldBody={...grant(),disclosureVersion:'custom-ais-owner-transactional-v1'};
 const oldKey='owner-sms-consent:receipt:'+createHash('sha256').update(oldBody.idempotencyKey).digest('hex');
 const old={id:randomUUID(),revision:1,action:'grant',active:true,sendingAuthorized:true,phone:'+16235550100',at:'2026-09-20T00:00:00.000Z',disclosureVersion:oldBody.disclosureVersion,disclosure:'Synthetic v1 disclosure: saving consent does not enable alerts.',purposes:['booking_success','actionable_operational_failures'],actor:{type:'authenticated_admin_session',reference:'synthetic-v1-actor'},requestFingerprint:createHash('sha256').update(JSON.stringify(['grant','+16235550100',0,oldBody.disclosureVersion])).digest('hex')};
 await h.store.kvSet('owner-sms-consent:current',old);await h.store.kvSet(oldKey,old);
 const before=await module.snapshot();assert.deepEqual(before.current,old);assert.equal(before.matchesConfiguredPhone,true);assert.equal(before.currentVersion,false);assert.equal(before.effectiveActive,false);assert.equal(await module.allows(phone),false);
 await assert.rejects(module.record(oldBody,'admin'),{status:400},'stale disclosure cannot be accepted through an old idempotency key');
 await assert.rejects(module.record({...grant(1),idempotencyKey:oldBody.idempotencyKey},'admin'),{status:409},'a current disclosure cannot reuse the old grant key');
 assert.deepEqual(await h.store.kvGet(oldKey),old);assert.deepEqual(await h.store.kvGet('owner-sms-consent:current'),old);
 const fresh=await module.record(grant(1),'admin');assert.equal(fresh.revision,2);assert.equal(fresh.currentVersion,true);assert.equal(fresh.effectiveActive,true);assert.equal(await module.allows(phone),true);
 assert.deepEqual(await h.store.kvGet(oldKey),old,'new consent must not rewrite historical disclosure or fields');
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,2);assert.equal(h.twilio.calls.length,0);
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} consent gate rejects inactive, mismatched, malformed and unreadable receipts`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}}),module=createOwnerConsent({store:h.store});
 const first=await module.record(grant(),'admin');
 assert.equal(await module.allows('+1 (623) 555-0100'),true);assert.equal(await module.allows('invalid'),false);
 for(const change of [{active:false},{active:'true'},{disclosureVersion:'custom-ais-owner-transactional-future'},{disclosureVersion:null},{phone:'+16235550199'}]){
  await h.store.kvSet('owner-sms-consent:current',{...first.receipt,...change});assert.equal(await module.allows(phone),false,JSON.stringify(change));assert.equal((await module.snapshot()).effectiveActive,false,JSON.stringify(change));
 }
 await h.store.kvSet('owner-sms-consent:current',first.receipt);
 const get=h.store.kvGet,config=h.store.config;
 try{h.store.kvGet=async()=>{throw new Error('Synthetic receipt read failure');};assert.equal(await module.allows(phone),false);await assert.rejects(module.snapshot());}finally{h.store.kvGet=get;}
 try{h.store.config=async()=>{throw new Error('Synthetic recipient read failure');};assert.equal(await module.allows(phone),false);}finally{h.store.config=config;}
 const c=await h.store.config();await h.store.set('config',{...c,bookingOwnerSmsPhone:''});await h.store.kvSet('owner-sms-consent:current',{...first.receipt,phone:null});
 assert.equal(await module.allows(''),false);assert.equal((await module.snapshot()).effectiveActive,false,'two invalid phones must not match');
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} consent gate observes revocation during its configuration read`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}}),module=createOwnerConsent({store:h.store});
 await module.record(grant(),'admin');assert.equal(await module.allows(phone),true);
 const config=h.store.config;let revoked=false;
 h.store.config=async()=>{const value=await config();if(!revoked){revoked=true;await module.record({action:'revoke',revision:1,idempotencyKey:randomUUID()},'admin');}return value;};
 try{assert.equal(await module.allows(phone),false);}finally{h.store.config=config;}
 assert.equal(revoked,true);assert.equal((await module.snapshot()).current.active,false);
});
for(const rest of [false,true])for(const legacy of [false,true])test(`${rest?'REST RPC':'PGlite'} enabled booking alerts do not send with ${legacy?'only v1 consent':'no consent receipt'}`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone,bookingOwnerSmsEnabled:true}});
 if(legacy)await h.store.kvSet('owner-sms-consent:current',{revision:1,active:true,sendingAuthorized:true,phone:'+16235550100',disclosureVersion:'custom-ais-owner-transactional-v1'});
 const booked=await h.book('cleaning',{...contact,smsConsent:false});assert.equal(booked.status,201,JSON.stringify(booked.data));
 assert.equal(h.twilio.calls.filter(c=>c[0]==='sms').length,0);const [appointment]=await h.store.appointments();assert.equal(appointment.status,'confirmed');assert.equal(await h.store.kvGet(`owner-booking-sms:${appointment.id}`),null);
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} concurrent grants serialize by revision and append receipts; revocation is durable and number-bound`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone}});const module=createOwnerConsent({store:h.store});
 const result=await Promise.allSettled([module.record(grant(),'a'),module.record(grant(),'b')]);assert.equal(result.filter(x=>x.status==='fulfilled').length,1);assert.equal(result.find(x=>x.status==='rejected').reason.status,409);
 assert.equal((await h.db.query("select key from bob.kv where key like 'owner-sms-consent:receipt:%'")).length,1,'losing revision must not append a receipt');
 const first=(await module.snapshot()).current;
 await module.record({action:'revoke',revision:1,idempotencyKey:randomUUID()},'a');assert.equal(await module.allows(phone),false);assert.equal(await module.allows('6235550199'),false);
 const history=await h.db.query("select value from bob.kv where key like 'owner-sms-consent:receipt:%'");assert.equal(history.length,2);assert.ok(history.some(r=>r.value.id===first.id&&r.value.active===true));
 await assert.rejects(module.record(grant(1),'a'),{status:409});
 await module.record({...grant(2),sendingAuthorized:false},'a');assert.equal(await module.allows(phone),true,'current consent is effective without a separate sending authorization field');assert.equal(Object.hasOwn((await module.snapshot()).current,'sendingAuthorized'),false);assert.equal(await module.allows('6235550199'),false);
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
 const before=await h.call('/api/admin/owner-sms-consent',{cookie});assert.equal(before.status,200);assert.equal(before.data.current,null);assert.equal(before.data.effectiveActive,false);assert.equal(before.data.currentVersion,false);assert.equal(Object.hasOwn(before.data,'readiness'),false);
 const body=grant();assert.equal((await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie,body,headers:{origin:'https://foreign.example'}})).status,403);
 const saved=await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie,body});assert.equal(saved.status,200,JSON.stringify(saved.data));
 assert.equal(saved.data.receipt.actor.type,'authenticated_admin_user');assert.equal(saved.data.receipt.actor.userId,owner.user.id);assert.equal(Object.hasOwn(saved.data.receipt,'sendingAuthorized'),false);assert.equal(saved.data.effectiveActive,true);assert.equal(h.twilio.calls.length,0,'saving consent itself does not send a message');
 const revoked=await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie,body:{action:'revoke',revision:1,idempotencyKey:randomUUID()}});assert.equal(revoked.status,200);
 const booked=await h.book('cleaning',{...contact,smsConsent:false});assert.equal(booked.status,201);assert.equal(h.twilio.calls.filter(c=>c[0]==='sms').length,0,'revocation gates existing booking alerts');
});
for(const rest of [false,true])test(`${rest?'REST RPC':'PGlite'} revocation during booking alert claim suppresses the actual send without undoing booking`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone,bookingOwnerSmsEnabled:true}});const module=createOwnerConsent({store:h.store});
 await module.record(grant(),'admin');assert.equal(await module.allows(phone),true);
 const query=h.store.db.query;let revoked=false;h.store.db.query=async(sql,args)=>{const rows=await query(sql,args);if(!revoked&&String(args?.[0]).startsWith('owner-booking-sms:')){revoked=true;await module.record({action:'revoke',revision:1,idempotencyKey:randomUUID()},'admin');}return rows;};
 const booked=await h.book('cleaning',{...contact,smsConsent:false});assert.equal(booked.status,201);assert.equal(revoked,true);assert.equal(h.twilio.calls.filter(c=>c[0]==='sms').length,0);assert.equal((await h.store.appointments())[0].status,'confirmed');
});
for(const rest of [false,true])for(const [stage,action,readThreshold] of [['generic SMS','revoke',2],['provider wrapper','revoke',3],['generic SMS','change recipient',2]])test(`${rest?'REST RPC':'PGlite'} ${action} during ${stage} configuration await prevents dispatch`,async t=>{
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:phone,bookingOwnerSmsEnabled:true}}),module=createOwnerConsent({store:h.store});
 await module.record(grant(),'admin');assert.equal(await module.allows(phone),true);
 const get=h.store.kvGet,config=h.store.config;let consentReads=0,injected=false;
 h.store.kvGet=async(key,...args)=>{const value=await get(key,...args);if(key==='owner-sms-consent:current')consentReads++;return value;};
 h.store.config=async()=>{
  const value=await config();
  // The first read is the initial gate, the second the post-claim gate, and
  // the third is the generic sender's guard before the provider wrapper.
  if(!injected&&consentReads===readThreshold){
   injected=true;
   if(action==='revoke')await module.record({action:'revoke',revision:1,idempotencyKey:randomUUID()},'admin');
   else await h.store.set('config',{...value,bookingOwnerSmsPhone:'6235550199'});
  }
  return value;
 };
 let booked;try{booked=await h.book('cleaning',{...contact,smsConsent:false});}finally{h.store.kvGet=get;h.store.config=config;}
 assert.equal(booked.status,201,JSON.stringify(booked.data));assert.equal(injected,true,'the intended configuration await must be reached');assert.equal(h.twilio.calls.filter(c=>c[0]==='sms').length,0);
 const [appointment]=await h.store.appointments();assert.equal(appointment.status,'confirmed');assert.equal((await h.store.kvGet(`owner-booking-sms:${appointment.id}`)).status,'failed_or_uncertain');assert.equal(await module.allows(phone),false);
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
 assert.equal((await module.snapshot()).revision,2);assert.equal(await module.allows(phone),true);
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
 assert.equal(Object.hasOwn(await module.snapshot(),'sendingAuthorized'),false);assert.equal((await module.snapshot()).effectiveActive,true);assert.equal(h.twilio.calls.length,0);
});
