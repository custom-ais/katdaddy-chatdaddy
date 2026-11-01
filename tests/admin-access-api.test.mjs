import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminAuth } from '../server/admin-auth.mjs';
import { OWNER_SMS_CONSENT_VERSION } from '../shared/owner-sms-consent.mjs';
import { harness } from './helpers.mjs';

const password='Synthetic-local-account-password-2026';
async function named(t,rest=false){
 const h=await harness(t,{rest,config:{bookingOwnerSmsPhone:'6235550100'}});
 const legacy=await h.login();
 const auth=createAdminAuth({store:h.store,clock:h.store.clock});
 const claim=await auth.prepareOwnerBootstrap({email:'owner@example.test',name:'Synthetic Owner'});
 let response=await h.call('/api/admin/owner-bootstrap/accept',{method:'POST',body:{token:claim.token,password}});
 assert.equal(response.status,200);
 response=await h.call('/api/admin/login',{method:'POST',body:{email:'owner@example.test',password}});
 assert.equal(response.status,200);assert.equal(response.data.pendingCutover,true);
 assert.equal((await h.call('/api/admin/data',{cookie:response.cookie})).status,401);
 await auth.activateNamedMode({ownerId:claim.user.id});
 const master=response.cookie;
 const invite=async(email,permissions)=>{
  const issued=await h.call('/api/admin/users/invite',{method:'POST',cookie:master,body:{email,name:'Synthetic Member',permissions}});
  assert.equal(issued.status,201);
  const rejected=await h.call('/api/admin/invite/accept',{method:'POST',body:{token:issued.data.token,password,role:'master'}});
  assert.equal(rejected.status,400);
  const accepted=await h.call('/api/admin/invite/accept',{method:'POST',body:{token:issued.data.token,password}});
  assert.equal(accepted.status,200);
  const login=await h.call('/api/admin/login',{method:'POST',body:{email,password}});
  assert.equal(login.status,200);
  return {cookie:login.cookie,principal:login.data.principal,issued:issued.data};
 };
 return {...h,legacy,auth,master,invite};
}
for(const rest of [false,true]){
 test(`${rest?'REST RPC':'PGlite'} HTTP: shared sessions cannot become users; restricted snapshots and mutation responses deny secrets`,async t=>{
  const h=await named(t,rest);
  assert.equal((await h.call('/api/admin/data',{cookie:h.legacy})).status,401);
  assert.equal((await h.call('/api/admin/login',{method:'POST',body:{password:'Test-only-strong-password-2026'}})).status,401);
  const member=await h.invite('viewer@example.test',['appointments.view','settings.business.view','settings.business.manage','account.password']);
  await h.store.insertAppointment({id:'SYNTHETIC-APPOINTMENT',customerName:'Fictional Customer',phone:'+16235550101',email:'',address:'100 Synthetic St',city:'Buckeye',zip:'85326',technicianId:'tech-ryan',technicianName:'Synthetic Technician',scheduledAt:'2026-09-23T18:00:00Z',durationMins:60,createdAt:'2026-09-21T20:00:00Z',status:'confirmed',price:9876.54,notes:'Private financial note $9876.54',revision:1});
  await h.store.insertRequest({id:'SYNTHETIC-REQUEST',name:'Restricted Inbox Person',status:'new',notes:'Inbox private'},null,randomUUID());
  const viewed=await h.call('/api/admin/data',{cookie:member.cookie});
  assert.equal(viewed.status,200);assert.equal(viewed.data.access.role,'member');assert.equal(viewed.data.appointments.length,1);assert.deepEqual(viewed.data.requests,[]);
  assert.equal(viewed.data.appointments[0].price,undefined);assert.equal(viewed.data.appointments[0].notes,undefined);assert.equal(viewed.data.config.bookingOwnerSmsPhone,'');
  assert.doesNotMatch(JSON.stringify(viewed.data),/9876|Restricted Inbox Person|Private financial note|password_hash|sessionHash/);
  for(const [method,path,body] of [['GET','/api/admin/users'],['GET','/api/admin/owner-sms-consent'],['POST','/api/admin/connections/refresh',{}],['GET','/api/admin/export'],['GET','/api/admin/future-page'],['POST','/api/admin/appointments',{}]]){
   assert.equal((await h.call(path,{method,cookie:member.cookie,body})).status,403,path);
  }
  const old=await h.store.config();
  const mixed=await h.call('/api/admin/config',{method:'PATCH',cookie:member.cookie,body:{version:old.version,businessName:'Not saved',bookingOwnerSmsEnabled:true}});
  assert.equal(mixed.status,403);assert.equal((await h.store.config()).businessName,old.businessName);
  const saved=await h.call('/api/admin/config',{method:'PATCH',cookie:member.cookie,body:{version:old.version,businessName:'Synthetic business'}});
  assert.equal(saved.status,200);assert.equal(saved.data.config.businessName,'Synthetic business');assert.deepEqual(saved.data.requests,[]);assert.equal(saved.data.appointments[0].price,undefined);assert.equal(saved.data.access.id,member.principal.id);
  assert.equal((await h.store.config()).bookingOwnerSmsPhone,'6235550100');
  const edit=await h.call('/api/admin/users/'+member.principal.id,{method:'PATCH',cookie:h.master,body:{version:member.principal.version,permissions:[]}});
  assert.equal(edit.status,200);assert.equal((await h.call('/api/admin/data',{cookie:member.cookie})).status,401);
  const login=await h.call('/api/admin/login',{method:'POST',body:{email:'viewer@example.test',password}});
  assert.equal(login.status,200);
  const empty=await h.call('/api/admin/data',{cookie:login.cookie});assert.equal(empty.status,200);assert.deepEqual(empty.data.appointments,[]);assert.deepEqual(empty.data.requests,[]);
  assert.equal((await h.call('/api/admin/setup',{method:'POST',body:{setupToken:'test-only-setup-token',password}})).status,403);
  assert.equal(h.twilio.calls.length,0);assert.equal(h.jobber.jobs.length,0);
 });
}
test('HTTP: named master consent records actor and remains held; foreign origins and public bootstrap issuance fail',async t=>{
 const h=await named(t);const member=await h.invite('limited@example.test',['settings.booking.view']);
 const body={action:'grant',revision:0,phone:'6235550100',consent:true,disclosureVersion:OWNER_SMS_CONSENT_VERSION,idempotencyKey:randomUUID()};
 assert.equal((await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie:member.cookie,body})).status,403);
 assert.equal((await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie:h.master,body,headers:{origin:'https://foreign.example'}})).status,403);
 const saved=await h.call('/api/admin/owner-sms-consent',{method:'POST',cookie:h.master,body});
 assert.equal(saved.status,200);assert.equal(saved.data.receipt.actor.type,'authenticated_admin_user');assert.equal(saved.data.sendingAuthorized,false);assert.equal(saved.data.effectiveActive,false);
 assert.equal((await h.call('/api/admin/owner-bootstrap/prepare',{method:'POST',cookie:h.master,body:{email:'intruder@example.test'}})).status,403);
 assert.equal((await h.call('/api/admin/activate',{method:'POST',cookie:h.master,body:{}})).status,403);
 assert.equal(h.twilio.calls.length,0);
});
test('HTTP: named write rechecks revoked session after body awaits and before persistence',async t=>{
 const h=await named(t);const member=await h.invite('editor@example.test',['settings.business.view','settings.business.manage']);
 const masterLogin=await h.auth.login({email:'owner@example.test',password});
 const config=await h.store.config();const original=h.store.config;let revoked=false;
 h.store.config=async()=>{const value=await original();if(!revoked){revoked=true;await h.auth.updateUser(masterLogin.principal,member.principal.id,{version:member.principal.version,status:'disabled'});}return value;};
 const response=await h.call('/api/admin/config',{method:'PATCH',cookie:member.cookie,body:{version:config.version,businessName:'Must not persist'}});
 assert.equal(response.status,401);assert.equal((await original()).businessName,config.businessName);
});
test('HTTP: OAuth callback rejects a revoked initiating account session and consumes state once',async t=>{
 const h=await named(t);const connect=await h.call('/api/admin/jobber/connect',{cookie:h.master});
 assert.equal(connect.status,302);const state=new URL(connect.headers.get('location')).searchParams.get('state');assert.ok(state);
 await h.auth.logout(h.master.slice('bob_user='.length));
 let exchanges=0;h.jobber.exchangeCode=async()=>{exchanges++;};
 const callback=await h.call('/api/jobber/callback?code=synthetic-code&state='+encodeURIComponent(state));
 assert.equal(callback.status,302);assert.match(callback.headers.get('location'),/jobber=failed/);assert.equal(exchanges,0);assert.equal(await h.store.kvGet('jobber:state:'+state),null);
});

test('HTTP: scheduling editor cannot redirect, remove, or plant the staff SMS fallback recipient',async t=>{
 const h=await named(t);const member=await h.invite('scheduler@example.test',['settings.schedule.view','settings.schedule.manage']);
 const techs=(await h.store.technicians()).map(t=>({...t,jobberUserId:'',...(t.id==='tech-ryan'?{phone:'6235550100'}:{})}));await h.store.set('technicians',techs);
 for(const approverPhone of ['', '6235550198']){
  const c=await h.store.config();await h.store.set('config',{...c,approver:{...c.approver,phone:approverPhone}});
  const changed=techs.map(t=>t.id==='tech-ryan'?{...t,phone:'6235550199'}:t);
  assert.equal((await h.call('/api/admin/technicians',{method:'POST',cookie:member.cookie,body:{technicians:changed}})).status,403);
  const truncated=techs.map(t=>t.id==='tech-ryan'?{...t,phone:'x'.repeat(30)+t.phone}:t);
  assert.equal((await h.call('/api/admin/technicians',{method:'POST',cookie:member.cookie,body:{technicians:truncated}})).status,403);
  assert.equal((await h.call('/api/admin/technicians',{method:'POST',cookie:member.cookie,body:{technicians:techs.filter(t=>t.id!=='tech-ryan')}})).status,403);
 }
 await h.store.set('technicians',techs.filter(t=>t.id!=='tech-ryan'));
 assert.equal((await h.call('/api/admin/technicians',{method:'POST',cookie:member.cookie,body:{technicians:techs}})).status,403);
 assert.equal(h.twilio.calls.length,0);
});

test('HTTP: explicit null cannot bypass Master-only technician provider mapping protection',async t=>{
 const h=await named(t);const member=await h.invite('mapping-editor@example.test',['settings.schedule.view','settings.schedule.manage']);
 const before=await h.store.technicians();assert.ok(before.some(t=>t.jobberUserId));
 const body={technicians:before.map(t=>({...t,jobberUserId:null}))};
 assert.equal((await h.call('/api/admin/technicians',{method:'POST',cookie:member.cookie,body})).status,403);
 assert.deepEqual((await h.store.technicians()).map(t=>t.jobberUserId),before.map(t=>t.jobberUserId));
 assert.equal(h.jobber.jobs.length,0);assert.equal(h.twilio.calls.length,0);
});

test('HTTP: revoked master cannot create OAuth state after awaited configuration read',async t=>{
 const h=await named(t);const actor=await h.auth.login({email:'owner@example.test',password});
 const original=h.store.config;let changed=false;
 h.store.config=async()=>{const config=await original();if(!changed){changed=true;await h.auth.updateUser(actor.principal,actor.principal.id,{version:actor.principal.version,name:'Updated Synthetic Owner'});}return config;};
 const result=await h.call('/api/admin/jobber/connect',{cookie:h.master});
 assert.equal(result.status,401);assert.equal((await h.db.query("select key from bob.kv where key like 'jobber:state:%'")).length,0);
});
