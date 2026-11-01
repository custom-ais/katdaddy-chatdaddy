import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverEmailOnce } from '../server/email-notification.mjs';
function setup() {
  const records = new Map(); let calls = 0;
  const store = { db:{query:async(_sql,[key,record])=>{if(records.has(key))return [];records.set(key,JSON.parse(record));return [{key}];}},kvGet:async key=>records.get(key),kvSet:async(key,value)=>records.set(key,value),log:async()=>{} };
  const args = {store,kind:'appointment_confirmed',id:'appt-1',to:' Customer@Example.test ',enabled:true,configured:true,message:{subject:'Test',text:'Body'},sendEmail:async msg=>{calls++;assert.equal(msg.to,'customer@example.test');return {status:'accepted',messageId:'msg-1'};},clock:()=>100};
  return {args,records,calls:()=>calls};
}
test('accepted email retains permanent claim and prior truth across recipient edits',async()=>{
  const h=setup();const first=await deliverEmailOnce(h.args);
  assert.equal(first.status,'accepted');assert.equal(first.delivery,'not_confirmed');
  assert.equal(JSON.stringify(first).includes('customer@'),false);
  const duplicate=await deliverEmailOnce({...h.args,to:'different@example.test'});
  assert.equal(duplicate.status,'already_attempted');assert.equal(duplicate.prior.status,'accepted');assert.equal(h.calls(),1);
  assert.equal((await deliverEmailOnce({...h.args,kind:'approval_pending'})).status,'accepted');assert.equal(h.calls(),2);
});
test('concurrent requests and timeout never duplicate the provider request',async()=>{
  const h=setup();let release;let calls=0;
  const blocked=new Promise(resolve=>{release=resolve;});
  const args={...h.args,sendEmail:async()=>{calls++;await blocked;throw Error('timeout containing sensitive content');}};
  const first=deliverEmailOnce(args);await new Promise(resolve=>setImmediate(resolve));
  const other=await deliverEmailOnce(args);assert.equal(other.status,'already_attempted');assert.equal(other.prior.status,'attempting');
  release();assert.equal((await first).status,'failed_or_uncertain');
  assert.equal((await deliverEmailOnce(args)).prior.status,'failed_or_uncertain');assert.equal(calls,1);
  assert.equal(JSON.stringify([...h.records.values()]).includes('sensitive'),false);
});
test('disabled, missing capability, or invalid recipient never consume a claim or send',async()=>{
  const h=setup();
  for(const change of [{enabled:false},{configured:false},{to:'a@example.test\nBcc: x@test.test'},{kind:'other'},{id:''}]) {
    assert.ok(['skipped','rejected'].includes((await deliverEmailOnce({...h.args,...change})).status));
  }
  assert.equal(h.calls(),0);assert.equal(h.records.size,0);
  assert.equal((await deliverEmailOnce(h.args)).status,'accepted');
});
test('claim outage prevents sending; result persistence outage never releases claim',async()=>{
  const h=setup();const query=h.args.store.db.query;
  h.args.store.db.query=async()=>{throw Error('db');};
  assert.equal((await deliverEmailOnce(h.args)).reason,'claim_failed');assert.equal(h.calls(),0);
  h.args.store.db.query=query;h.args.store.kvSet=async()=>{throw Error('db');};h.args.store.log=async()=>{throw Error('log');};
  assert.equal((await deliverEmailOnce(h.args)).status,'accepted');
  assert.equal((await deliverEmailOnce(h.args)).prior.status,'attempting');assert.equal(h.calls(),1);
});
test('definite rejection remains permanent and generic while uncertain errors remain uncertain',async()=>{
  for(const [code,uncertain,status] of [['SENDGRID_REJECTED',false,'rejected'],['SENDGRID_UNCERTAIN',true,'failed_or_uncertain']]) {
    const h=setup();let calls=0;const args={...h.args,sendEmail:async()=>{calls++;throw Object.assign(Error('secret provider body'),{code,uncertain});}};
    const result=await deliverEmailOnce(args);assert.equal(result.status,status);assert.equal(JSON.stringify(result).includes('secret'),false);
    assert.equal((await deliverEmailOnce(args)).prior.status,status);assert.equal(calls,1);
  }
});

test('missing or malformed acceptance never claims delivery or acceptance and never retries',async()=>{
  for(const response of [undefined,null,{}, {status:'sent'}, {messageId:'not-acceptance'}]) {
    const h=setup();let calls=0;const args={...h.args,sendEmail:async()=>{calls++;return response;}};
    const result=await deliverEmailOnce(args);assert.equal(result.status,'failed_or_uncertain');assert.equal(result.delivery,'not_confirmed');
    assert.equal((await deliverEmailOnce(args)).prior.status,'failed_or_uncertain');assert.equal(calls,1);
  }
});
