import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectionHealth,observeMessaging} from '../server/connection-health.mjs';
function fixture(env={}){let now=1000;const values=new Map();const config={integrations:{},aiProvider:'gemini'};let locked=false,queries=0;const store={config:async()=>config,kvGet:async k=>values.get(k),kvSet:async(k,v)=>values.set(k,v),lock:async()=>{if(locked)return false;locked=true;return true;},db:{kind:'test',query:async()=>{queries++;return [{ok:1}];}}};const health=createConnectionHealth({store,env,clock:()=>now,jobber:{accountIdentityRevision:async()=> 'same'}});return {store,health,values,config,advance:n=>now+=n,queries:()=>queries};}
test('passive unknown until a real observed operation; accepted never claims delivery',async()=>{
 const h=fixture();assert.equal((await h.health.snapshot()).sms.status,'unknown');assert.equal(h.queries(),0);
 let calls=0;await h.health.observe('sms','send_message',async()=>{calls++;return {status:'queued'};},{meaning:'accepted_not_delivered'})();
 const s=(await h.health.snapshot()).sms;assert.equal(calls,1);assert.equal(s.status,'healthy');assert.equal(s.meaning,'accepted_not_delivered');assert.equal(s.lastSuccessAt,1000);assert.equal('revision' in s,false);
 h.advance(900001);assert.equal((await h.health.snapshot()).sms.status,'unknown');assert.equal((await h.health.snapshot()).sms.stale,true);
});
test('credential revision and tenant switches prevent stale green or pending-result rebinding',async()=>{
 const env={SENDGRID_API_KEY:'first-private'};const h=fixture(env);await h.health.observe('email','send_email',async()=>({status:'accepted'}))();env.SENDGRID_API_KEY='second-private';assert.equal((await h.health.snapshot()).email.status,'unknown');
 h.config.integrations.email=false;assert.equal((await h.health.snapshot()).email.status,'off');h.config.integrations.email=true;
 await h.health.observe('email','send_email',async()=>{env.SENDGRID_API_KEY='third-private';return {};})();assert.equal((await h.health.snapshot()).email.status,'unknown');
 assert.equal(JSON.stringify(await h.health.snapshot()).includes('private'),false);
});
test('failures generic; disabled operation and metadata lookup failure do not overwrite send success',async()=>{
 const h=fixture();await h.health.observe('sms','send_message',async()=>({}))();
 await h.health.refresh({integrationAccounts:{refresh:async()=>({twilio:{status:'unavailable'}})}});assert.equal((await h.health.snapshot()).sms.status,'healthy');
 await assert.rejects(h.health.observe('sms','send_message',async()=>{throw Error('secret provider response');})());const s=(await h.health.snapshot()).sms;assert.equal(s.status,'error');assert.equal(JSON.stringify(s).includes('secret'),false);assert.equal(s.lastSuccessAt,1000);
 h.config.integrations.sms=false;await assert.rejects(h.health.observe('sms','send_message',async()=>{throw Error('off');})());assert.equal((await h.health.snapshot()).sms.status,'off');
});
test('refresh only database and explicit account reads, with cross-instance cooldown and disabled gates',async()=>{
 const h=fixture();let reads=0;
 const accounts={refresh:async()=>{reads++;return {jobber:{status:'verified'}};}};
 assert.deepEqual(await h.health.refresh({integrationAccounts:accounts}),{checked:true});assert.equal(h.queries(),1);assert.equal(reads,1);assert.equal((await h.health.snapshot()).database.status,'healthy');assert.equal((await h.health.snapshot()).jobber.status,'healthy');
 assert.equal((await h.health.refresh({integrationAccounts:accounts})).reason,'cooldown');assert.equal(reads,1);assert.equal(h.queries(),1);
});
test('wrappers observe valid responses, preserve result/error and selected AI binding',async()=>{
 const h=fixture();let calls=0;const assistant={providers:{gemini:{configured:true}},forProvider:provider=>Object.freeze({provider,configured:true,interpret:async()=>({command:null})})};
 const x=observeMessaging({health:h.health,twilio:{verifyConfigured:true,sendVerification:async()=>{calls++;return {status:'pending'};},checkVerification:async()=>({status:'approved'}),sendSms:async()=>({messageId:'SM-example',status:'queued'})},sendgrid:{configured:true,sendEmail:async()=>({status:'accepted'})},assistant});
 await x.twilio.sendVerification();await x.twilio.checkVerification();await x.twilio.sendSms();await x.sendgrid.sendEmail();await x.assistant.forProvider('gemini').interpret();
 const s=await h.health.snapshot();for(const k of ['verification','sms','email','assistant'])assert.equal(s[k].status,'healthy');assert.equal(calls,1);
 h.config.aiProvider='openai';assert.equal((await h.health.snapshot()).assistant.status,'unknown');await x.assistant.forProvider('gemini').interpret();assert.equal((await h.health.snapshot()).assistant.status,'unknown');
});
test('diagnostic storage failure never changes provider return or exception',async()=>{
 const h=fixture();h.store.kvSet=async()=>{throw Error('DB');};assert.equal(await h.health.observe('email','send_email',async()=>42)(),42);const err=Error('provider');await assert.rejects(h.health.observe('email','send_email',async()=>{throw err;})(),e=>e===err);
});

test('failed explicit Jobber read clears its recent green without touching messaging observations',async()=>{
 const h=fixture();let allow=true;h.store.lock=async()=>true;
 await h.health.observe('sms','send_message',async()=>({}))();
 const integrationAccounts={refresh:async()=>({jobber:allow?{status:'verified'}:{status:'unavailable',checkedAt:1001}})};
 await h.health.refresh({integrationAccounts});assert.equal((await h.health.snapshot()).jobber.status,'healthy');allow=false;await h.health.refresh({integrationAccounts});
 assert.equal((await h.health.snapshot()).jobber.status,'error');assert.equal((await h.health.snapshot()).sms.status,'healthy');
});
test('AI adapter failure never produces a healthy observation',async()=>{
 const h=fixture();const assistant={providers:{},forProvider:provider=>({provider,configured:false,interpret:async()=>{throw Object.assign(Error('unconfigured'),{code:'AI_PROVIDER_UNAVAILABLE'});}})};
 const noop=async()=>({});const x=observeMessaging({health:h.health,assistant,twilio:{sendVerification:noop,checkVerification:noop,sendSms:noop},sendgrid:{sendEmail:noop}});
 await assert.rejects(x.assistant.forProvider('gemini').interpret());assert.equal((await h.health.snapshot()).assistant.status,'error');assert.equal((await h.health.snapshot()).assistant.lastSuccessAt,null);
});

test('database observation expires on database credential revision without exposing values',async()=>{
 const env={DATABASE_URL:'postgres://private-one'};const h=fixture(env);await h.health.refresh();assert.equal((await h.health.snapshot()).database.status,'healthy');env.DATABASE_URL='postgres://private-two';assert.equal((await h.health.snapshot()).database.status,'unknown');assert.equal(JSON.stringify(await h.health.snapshot()).includes('postgres://'),false);
});
