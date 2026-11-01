import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, contact } from './helpers.mjs';

async function toggle(h, name, value) {
  const c=await h.store.config(); await h.store.set('config',{...c,integrations:{...c.integrations,[name]:value}});
}

test('disabling Jobber after verification prevents new holds without reading or mutating provider',async t=>{
  const h=await harness(t);const token=await h.prepare();
  const [slot]=await h.slots(token);
  let reads=0;h.jobber.readVisits=async()=>{reads++;throw Error('must not call disabled Jobber');};
  await toggle(h,'jobber',false);
  assert.equal((await h.call('/api/public/config')).data.bookingEnabled,false);
  const r=await h.hold(token,slot.scheduledAt);
  assert.ok(r.status>=400,JSON.stringify(r.data));assert.equal(reads,0);assert.equal(h.jobber.jobs.length,0);
});

test('disabled Maps prevents Google/Census-like geocoding and booking while ordinary config remains readable',async t=>{
  const h=await harness(t);const token=await h.accept();let calls=0;
  h.geo.geocode=async()=>{calls++;throw Error('must not call disabled maps');};
  await toggle(h,'maps',false);
  const config=await h.call('/api/public/config');assert.equal(config.status,200);assert.equal(config.data.bookingEnabled,false);assert.equal(config.data.addressSuggestions,false);
  const r=await h.call('/api/contact',{method:'POST',token,body:contact});
  assert.ok(r.status>=400,JSON.stringify(r.data));assert.equal(calls,0);assert.equal(h.jobber.jobs.length,0);
});

test('disabled verification refuses sends/checks and never becomes a bypass for booking',async t=>{
  const h=await harness(t);const token=await h.accept();
  await h.call('/api/contact',{method:'POST',token,body:contact});
  await toggle(h,'verification',false);
  const before=h.twilio.calls.length;
  for(const [path,body] of [['/api/verify/send',{channel:'sms'}],['/api/verify/check',{code:'1234'}]]) {
    assert.ok((await h.call(path,{method:'POST',token,body})).status>=400);
  }
  assert.equal(h.twilio.calls.length,before);
  assert.equal((await h.call('/api/public/config')).data.bookingEnabled,false);
  assert.equal(h.jobber.jobs.length,0);
});

test('disabled appointment SMS leaves Verify independent and suppresses customer/owner alerts',async t=>{
  const h=await harness(t,{config:{bookingOwnerSmsEnabled:true,bookingOwnerSmsPhone:'6235550100'}});
  await toggle(h,'sms',false);
  const config=await h.call('/api/public/config');assert.equal(config.data.textMessages,false);assert.equal(config.data.bookingEnabled,true);
  const r=await h.book('cleaning',{...contact,smsConsent:true});
  assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal(h.twilio.calls.some(c=>c[0]==='sms'),false);
  assert.equal(h.jobber.jobs.length,1);
});

test('AI selection uses exactly selected configured provider, never falls back, and honors master off',async t=>{
  const calls=[];
  const providers={gemini:{configured:true,model:'mock-gemini',interpret:async()=>{calls.push('gemini');return {facts:{},question:false};}},openai:{configured:true,model:'mock-openai',interpret:async()=>{calls.push('openai');return {facts:{},question:false};}}};
  const assistant={forProvider:name=>providers[name],providers:{gemini:{configured:true},openai:{configured:true}}};
  const h=await harness(t,{assistant});
  const ask=async()=>h.chat(await h.fresh(),'Need my vent cleaned — two story house, takes many cycles to dry');
  await ask();assert.deepEqual(calls,['gemini']);
  let c=await h.store.config();await h.store.set('config',{...c,aiProvider:'openai'});
  await ask();assert.deepEqual(calls,['gemini','openai']);
  providers.openai.configured=false;
  assert.equal((await h.call('/api/public/config')).data.smartChat,false);
  await ask();assert.deepEqual(calls,['gemini','openai'],'missing selected provider must not fallback');
  c=await h.store.config();providers.openai.configured=true;await h.store.set('config',{...c,aiAssistant:false});
  await ask();assert.deepEqual(calls,['gemini','openai']);
  assert.equal((await h.call('/api/public/config')).data.smartChat,false);
});

test('required verification stays fail closed with missing provider and customer SMS off',async t=>{
  const h=await harness(t,{config:{smsConfirmations:false,requirePhoneVerification:true},env:{BOOKING_VERIFICATION_PROVIDER:''}});
  assert.equal((await h.call('/api/public/config')).data.bookingEnabled,false,'no provider must not become a verification bypass');
});

test('explicit legacy verification-optional policy is preserved without a selected Twilio provider',async t=>{
  const h=await harness(t,{config:{smsConfirmations:false,requirePhoneVerification:false},env:{BOOKING_VERIFICATION_PROVIDER:''}});
  let config=(await h.call('/api/public/config')).data;
  assert.equal(config.bookingEnabled,true);assert.equal(config.phoneVerification,false);
  await toggle(h,'verification',false);
  config=(await h.call('/api/public/config')).data;
  assert.equal(config.bookingEnabled,true);assert.equal(config.phoneVerification,false);
});

test('explicitly selected Twilio still requires verification despite legacy optional setting',async t=>{
  const h=await harness(t,{config:{smsConfirmations:false,requirePhoneVerification:false}});
  assert.equal((await h.call('/api/public/config')).data.phoneVerification,true);
  await toggle(h,'verification',false);
  assert.equal((await h.call('/api/public/config')).data.bookingEnabled,false);
});
