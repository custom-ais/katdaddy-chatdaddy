import test from 'node:test';
import assert from 'node:assert/strict';
import {createClientHub,CLIENT_HUB_EPOCH} from '../server/client-hub.mjs';
import {createJobber} from '../server/jobber.mjs';
import {harness,contact} from './helpers.mjs';
const url='https://clienthub.getjobber.com/client_hubs/12345678-1234-1234-1234-123456789abc/login/new?source=share_login';
function fake(){
 const kv=new Map();let id='account-a',connected=true,fail=false,calls=0;
 const store={config:async()=>({}),kvGet:async k=>kv.get(k),kvSet:async(k,v)=>kv.set(k,v),kvDel:async k=>kv.delete(k)};
 const jobber={connected:async()=>connected,accountIdentity:async()=>{calls++;if(fail)throw Error('outage');return {id,name:`Business ${id}`,verified:true};}};
 const hub=createClientHub({store,jobber,clock:()=>100});
 const configure=async()=>hub.save({url,confirmAccount:true,...await hub.challenge()});
 return {hub,kv,configure,calls:()=>calls,setId:v=>id=v,setConnected:v=>connected=v,setFail:v=>fail=v};
}
const appt={status:'confirmed',jobber:{accountId:'account-a',clientHubEpoch:'legacy'}};
test('unconfigured hub makes no provider calls; binding requires server verified explicit confirmation',async()=>{
 const h=fake();assert.equal(await h.hub.capture(),null);assert.equal(h.calls(),0);
 await assert.rejects(h.hub.save({url,confirmAccount:true,accountId:'account-a'}));
 const challenge=await h.hub.challenge();await assert.rejects(h.hub.save({url,...challenge}));
 await h.hub.save({url,...challenge,confirmAccount:true,accountId:'attacker'});
 assert.equal(await h.hub.resolve(appt),url);assert.equal((await h.hub.snapshot()).accountName,'Business account-a');
 assert.equal(JSON.stringify(await h.hub.snapshot()).includes('accountId'),false);
});
test('account switch between displayed confirmation and save is rejected',async()=>{
 const h=fake();const challenge=await h.hub.challenge();h.setId('account-b');
 await assert.rejects(h.hub.save({url,confirmAccount:true,...challenge}));assert.equal((await h.hub.snapshot()).enabled,false);
});
test('token refresh same stable identity retains binding; connection epoch requires reconfirmation',async()=>{
 const h=fake();await h.configure();assert.equal(await h.hub.resolve(appt),url);
 h.kv.set(CLIENT_HUB_EPOCH,'new-connection');assert.equal(await h.hub.resolve(appt),'');
 h.kv.delete(CLIENT_HUB_EPOCH);assert.equal(await h.hub.resolve(appt),'','old epoch returning must not reactivate');
});
test('account mismatch disables permanently and returning account cannot reactivate',async()=>{
 const h=fake();await h.configure();h.setId('account-b');assert.equal(await h.hub.resolve(appt),'');h.setId('account-a');assert.equal(await h.hub.resolve(appt),'');
 assert.equal((await h.hub.snapshot()).enabled,false);
});
test('unknown identity omits link, old unbound bookings and unconfirmed bookings never get link',async()=>{
 const h=fake();await h.configure();h.setFail(true);assert.equal(await h.hub.resolve(appt),'');h.setFail(false);
 for(const a of [{status:'confirmed',jobber:{}},{...appt,status:'action_needed'},{status:'confirmed',jobber:{accountId:'account-b',clientHubEpoch:'legacy'}}])assert.equal(await h.hub.resolve(a),'');
 assert.equal(await h.hub.resolve(appt),url);
});
test('blank disable is explicit and consumes no provider read',async()=>{
 const h=fake();await h.configure();const before=h.calls();await h.hub.save({url:''});assert.equal(h.calls(),before);assert.equal(await h.hub.resolve(appt),'');
});
test('admin endpoint authenticates and uses server identity, booking confirmation includes only bound link',async t=>{
 const sendgrid={configured:true,calls:[],async sendEmail(to,message){this.calls.push({to,...message});return {status:'accepted'};}};
 const h=await harness(t,{sendgrid,env:{BOOKING_EMAIL_PROVIDER:'sendgrid'}});
 h.jobber.accountIdentity=async()=>({id:'account-a',name:'Verified Business',verified:true});
 assert.ok((await h.call('/api/admin/jobber/client-hub/identity',{method:'POST',body:{}})).status>=400);
 const cookie=await h.login();
 const challenge=await h.call('/api/admin/jobber/client-hub/identity',{method:'POST',cookie,body:{}});assert.equal(challenge.status,200);
 const saved=await h.call('/api/admin/jobber/client-hub',{method:'POST',cookie,body:{url,confirmAccount:true,confirmationToken:challenge.data.confirmationToken,accountId:'forged'}});assert.equal(saved.status,200,JSON.stringify(saved.data));
 const booked=await h.book('cleaning',{...contact,email:'test@example.test'});assert.equal(booked.status,201,JSON.stringify(booked.data));
 assert.equal(sendgrid.calls.length,1);assert.ok(sendgrid.calls[0].text.includes(url));
 for(let i=0;i<2;i++) assert.equal((await h.call(`/api/admin/appointments/${booked.data.receipt.id}/confirmation`,{method:'POST',cookie,body:{}})).status,200);
 assert.equal(sendgrid.calls.length,1,'Client Hub confirmation retries remain deduplicated');
 await h.call('/api/admin/jobber/disconnect',{method:'POST',cookie,body:{}});
 assert.equal((await h.store.kvGet('client-hub:binding')).enabled,false);
});

test('observed disconnect permanently disables even if the original account returns',async()=>{
 const h=fake();await h.configure();h.setConnected(false);assert.equal(await h.hub.resolve(appt),'');h.setConnected(true);assert.equal(await h.hub.resolve(appt),'');
});

test('identity provider errors are replaced with a safe reconfirmation error',async()=>{
 const h=fake();const challenge=await h.hub.challenge();h.setFail(true);
 await assert.rejects(h.hub.save({url,confirmAccount:true,...challenge}),e=>e.status===409&&!e.message.includes('outage'));
});

test('expired or consumed account-confirmation challenges cannot be reused',async()=>{
 const h=fake();const challenge=await h.hub.challenge();
 h.kv.get(`client-hub:confirm:${challenge.confirmationToken}`).expiresAt=99;
 await assert.rejects(h.hub.save({url,confirmAccount:true,...challenge}));
 const next=await h.hub.challenge();await h.hub.save({url,confirmAccount:true,...next});
 await assert.rejects(h.hub.save({url,confirmAccount:true,...next}));
});

test('actual Jobber token refresh preserves Client Hub connection epoch; exchange/disconnect rotate it',async()=>{
 const cache=new Map([[CLIENT_HUB_EPOCH,'original-connection']]);let tokens={accessToken:'expired-fake',refreshToken:'refresh-one',expiresAt:0};let refreshes=0;
 const store={kvGet:async k=>cache.get(k),kvSet:async(k,v)=>cache.set(k,v),lock:async()=>true,unlock:async()=>{}};
 const api=createJobber({store,env:{JOBBER_CLIENT_ID:'fake-client',JOBBER_CLIENT_SECRET:'fake-secret',JOBBER_REDIRECT_URI:'https://example.test/callback'},tokens:{load:async()=>tokens,save:async v=>{tokens=v;},clear:async()=>{tokens=null;}},fetchImpl:async(url,init)=>{
  if(url.endsWith('/oauth/token')){refreshes++;return new Response(JSON.stringify({access_token:'new-fake-access',refresh_token:'refresh-two',expires_in:3600}),{status:200});}
  assert.equal(url,'https://api.getjobber.com/api/graphql');return new Response(JSON.stringify({data:{account:{id:'stable-account',name:'Stable Business'}}}),{status:200});
 }});
 assert.equal((await api.accountIdentity()).id,'stable-account');assert.equal(refreshes,1);assert.equal(cache.get(CLIENT_HUB_EPOCH),'original-connection');
 await api.exchangeCode('fake-code');const epoch=cache.get(CLIENT_HUB_EPOCH);assert.notEqual(epoch,'original-connection');
 await api.disconnect();assert.notEqual(cache.get(CLIENT_HUB_EPOCH),epoch);assert.equal(tokens,null);
});
