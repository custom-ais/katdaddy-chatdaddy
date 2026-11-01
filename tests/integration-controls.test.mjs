import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, withConfigDefaults, validateConfig } from '../shared/domain.mjs';
import { createIntegrationControls, controlProviders } from '../server/integration-controls.mjs';

test('legacy config defaults preserve enabled integrations and Gemini; partial toggles retain false', () => {
  const legacy=withConfigDefaults({});
  assert.equal(legacy.aiProvider,'gemini');
  assert.deepEqual(legacy.integrations,{jobber:true,maps:true,verification:true,sms:true,email:true});
  assert.deepEqual(withConfigDefaults({integrations:{maps:false}}).integrations,{jobber:true,maps:false,verification:true,sms:true,email:true});
  legacy.integrations.sms=false;
  assert.equal(DEFAULT_CONFIG.integrations.sms,true,'no shared defaults mutation');
  assert.equal(validateConfig({...DEFAULT_CONFIG,aiProvider:'openai'}).some(x=>/AI provider|integration/.test(x)),false);
  for(const change of [{aiProvider:'unknown'},{integrations:{...DEFAULT_CONFIG.integrations,sms:'false'}},{integrations:null},{integrations:{...DEFAULT_CONFIG.integrations,database:false}}]) {
    assert.ok(validateConfig({...DEFAULT_CONFIG,...change}).some(x=>/AI provider|integration/.test(x)));
  }
});

test('latest persisted flags gate every method and fail closed on configuration outage', async () => {
  let config=withConfigDefaults({}), failRead=false, reads=0;
  const controls=createIntegrationControls({store:{config:async()=>{reads++;if(failRead)throw Error('db unavailable');return config;}}});
  const calls=[]; const method=name=>async(...args)=>{calls.push([name,args]);return name;};
  const raw={jobber:{appConfigured:true,connected:method('connected'),readVisits:method('visits'),gql:method('gql'),createScheduledJob:method('create'),disconnect:method('disconnect'),authorizeUrl:()=> 'oauth-url'},geo:{provider:'google',suggestions:true,geocode:method('geo'),driveMinutes:method('drive'),roadRoutes:method('roads'),suggestAddresses:method('suggest'),addressFor:method('details'),serviceAreaSamples:method('samples'),diagnostics:method('diag')},twilio:{verifyConfigured:true,messagingConfigured:true,sendVerification:method('verify'),checkVerification:method('check'),sendSms:method('sms')},sendgrid:{configured:true,sendEmail:method('email')}};
  const p=controlProviders({controls,...raw});
  assert.equal(p.jobber.appConfigured,true);assert.equal(p.geo.provider,'google');assert.equal(p.twilio.verifyConfigured,true);
  await p.jobber.readVisits(1,2);await p.twilio.sendVerification({channel:'email'});
  config={...config,integrations:{jobber:false,maps:false,verification:false,sms:false,email:false}};
  assert.equal(await p.jobber.connected(),false);
  for(const invoke of [()=>p.jobber.readVisits(),()=>p.jobber.gql(),()=>p.jobber.createScheduledJob(),()=>p.twilio.sendVerification(),()=>p.twilio.checkVerification(),()=>p.twilio.sendSms(),()=>p.sendgrid.sendEmail()]) await assert.rejects(invoke,{code:'INTEGRATION_DISABLED'});
  await assert.rejects(p.geo.geocode('address'),{code:'GEO_UNAVAILABLE'});
  await assert.rejects(p.geo.roadRoutes([]),{code:'ROUTING_UNAVAILABLE'});
  assert.deepEqual(await p.geo.driveMinutes([{},{}]),[null,null]);
  assert.deepEqual(await p.geo.suggestAddresses('a'),[]);assert.equal(await p.geo.addressFor('p'),null);assert.deepEqual(await p.geo.serviceAreaSamples({},2),[]);
  assert.equal(calls.length,2,'disabled operations never invoke provider, even cached provider methods');
  assert.equal(p.jobber.authorizeUrl(),'oauth-url');await p.jobber.disconnect();await p.geo.diagnostics();
  failRead=true;assert.equal(await controls.enabled('maps'),false);await assert.rejects(p.twilio.sendSms(),{code:'INTEGRATION_DISABLED'});
  assert.ok(reads>10);
});

test('fetch gate rechecks before each compound-provider request and passes arguments unchanged', async () => {
  const config=withConfigDefaults({});let calls=0;
  const controls=createIntegrationControls({store:{config:async()=>config}});
  const init={method:'POST',body:'mock'};
  const fetchImpl=async(url,options)=>{calls++;assert.equal(url,'https://example.test/provider');assert.equal(options,init);return 'mock';};
  const guarded=controls.fetchFor('jobber',fetchImpl);
  assert.equal(await guarded('https://example.test/provider',init),'mock');
  config.integrations.jobber=false;
  await assert.rejects(guarded('https://example.test/provider',init),{code:'INTEGRATION_DISABLED'});
  assert.equal(calls,1);
  assert.equal(await controls.enabled('database'),false);
  await assert.rejects(controls.fetchFor('database',fetchImpl)('ignored'),{code:'INTEGRATION_DISABLED'});
});

test('provider proxy preserves mutable metadata and guards replacement methods', async () => {
  const config=withConfigDefaults({});const controls=createIntegrationControls({store:{config:async()=>config}});
  const raw={appConfigured:true,flag:'old',readVisits:async()=> 'old'};
  const wrapped=controlProviders({controls,jobber:raw}).jobber;
  wrapped.flag='new';assert.equal(raw.flag,'new');
  raw.readVisits=async function(){return this.flag;};
  assert.equal(await wrapped.readVisits(),'new');
  config.integrations.jobber=false;
  await assert.rejects(wrapped.readVisits(),{code:'INTEGRATION_DISABLED'});
  assert.equal(wrapped.appConfigured,true,'metadata remains capability, not enabled status');
});

test('email defaults do not create a provider and email method/transport gates stay independent of Verify', async () => {
  const config=withConfigDefaults({});let calls=0;
  const controls=createIntegrationControls({store:{config:async()=>config}});
  assert.equal(controlProviders({controls}).sendgrid,undefined);
  const sendgrid={configured:true,sendEmail:async()=>{calls++;return 'accepted';}};
  const guarded=controlProviders({controls,sendgrid}).sendgrid;
  assert.equal(await guarded.sendEmail(),'accepted');
  const transport=controls.fetchFor('email',async()=>{calls++;return 'sent';});
  assert.equal(await transport('mock'),'sent');
  config.integrations.email=false;
  await assert.rejects(guarded.sendEmail(),{code:'INTEGRATION_DISABLED'});
  await assert.rejects(transport('mock'),{code:'INTEGRATION_DISABLED'});
  assert.equal(await controls.enabled('verification'),true);assert.equal(calls,2);
  assert.ok(validateConfig({...config,integrations:{...config.integrations,email:'false'}}).some(x=>/email/.test(x)));
});
