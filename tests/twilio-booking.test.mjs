import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, contact } from './helpers.mjs';
function fakeVerify() {
  const calls = [];
  return { calls, verifyConfigured: true, messagingConfigured: false,
    async sendVerification(args) { calls.push(args); return {sid:'VE'+'1'.repeat(32),status:'pending'}; },
    async checkVerification({code}) { return {status:code==='1234'?'approved':'pending'}; } };
}
test('Twilio email choice verifies email only and permits normal booking with SMS off', async t => {
  const twilio=fakeVerify();
  const h=await harness(t,{twilio,env:{BOOKING_VERIFICATION_PROVIDER:'twilio'},config:{smsConfirmations:false}});
  const token=await h.accept();
  const r=await h.call('/api/contact',{method:'POST',token,body:{...contact,email:'test@example.com'}});
  assert.equal(r.status,200); assert.equal(r.data.verification.chooseChannel,true); assert.equal(twilio.calls.length,0);
  assert.equal((await h.call('/api/availability',{token})).status,409);
  const sent=await h.call('/api/verify/send',{method:'POST',token,body:{channel:'email'}});
  assert.equal(sent.status,200,JSON.stringify(sent.data)); assert.equal(sent.data.verification.channel,'email');
  const ok=await h.call('/api/verify/check',{method:'POST',token,body:{code:'1234'}});
  assert.equal(ok.status,200,JSON.stringify(ok.data)); assert.equal(ok.data.session.verifiedContact.channel,'email'); assert.equal(ok.data.session.phoneVerified,undefined);
  const slots=await h.slots(token); assert.ok(slots.length); assert.equal(slots[0].approval,false);
  const held=await h.hold(token,slots[0].scheduledAt); const booked=await h.confirm(token,held.data.hold);
  assert.equal(booked.status,201,JSON.stringify(booked.data));
  assert.equal(h.lc.calls.some(c=>c[0]==='sms'),false);
  assert.equal(h.lc.calls.length,0,'removed CRM/email provider is never called');
  assert.equal((await h.store.appointments())[0].notifications.emailReason,'disabled_or_not_configured');
});
test('Twilio selection fails closed if unconfigured, even when customer text confirmations are off',async t=>{
 const h=await harness(t,{twilio:null,env:{BOOKING_VERIFICATION_PROVIDER:'twilio'},config:{smsConfirmations:false}});
 assert.equal((await h.call('/api/public/config')).data.bookingEnabled,false);
});
test('Twilio SMS ownership and replay protection through API',async t=>{
 const h=await harness(t,{twilio:fakeVerify(),env:{BOOKING_VERIFICATION_PROVIDER:'twilio'}}); const token=await h.accept();
 await h.call('/api/contact',{method:'POST',token,body:contact});
 assert.equal((await h.call('/api/verify/send',{method:'POST',token,body:{channel:'sms'}})).status,200);
 const ok=await h.call('/api/verify/check',{method:'POST',token,body:{code:'1234'}});assert.equal(ok.status,200);assert.ok(ok.data.session.phoneVerified);
 assert.equal((await h.call('/api/verify/check',{method:'POST',token,body:{code:'1234'}})).status,409);
});
test('editing the verified email relocks booking and cannot reuse its code',async t=>{
 const h=await harness(t,{twilio:fakeVerify(),env:{BOOKING_VERIFICATION_PROVIDER:'twilio'}});const token=await h.accept();
 await h.call('/api/contact',{method:'POST',token,body:{...contact,email:'first@example.com'}});
 await h.call('/api/verify/send',{method:'POST',token,body:{channel:'email'}});
 await h.call('/api/verify/check',{method:'POST',token,body:{code:'1234'}});
 const edit=await h.call('/api/contact',{method:'POST',token,body:{...contact,email:'second@example.com'}});
 assert.equal(edit.data.session.stage,'verify');assert.equal(edit.data.verification.chooseChannel,true);
 assert.equal((await h.call('/api/availability',{token})).status,409);
 assert.equal((await h.call('/api/verify/check',{method:'POST',token,body:{code:'1234'}})).status,409);
});
test('pending codes in chat prose never reach stored history/activity and safety still wins',async t=>{
 const h=await harness(t,{twilio:fakeVerify(),env:{BOOKING_VERIFICATION_PROVIDER:'twilio'}});const token=await h.accept();
 await h.call('/api/contact',{method:'POST',token,body:contact});
 const reply=await h.call('/api/chat',{method:'POST',token,body:{message:'my code is 987654'}});
 assert.equal(reply.status,200);assert.match(reply.data.reply,/code box/);assert.equal(reply.data.via,'rules');
 assert.equal(JSON.stringify(reply.data.session).includes('987654'),false);
 const safety=await h.call('/api/chat',{method:'POST',token,body:{message:'my code is 987654 and there is smoke coming from the dryer'}});
 assert.equal(safety.status,200);assert.ok(safety.data.session.safety);
 assert.equal(JSON.stringify(safety.data.session).includes('987654'),false);
 const events=await h.db.query('select data from bob.events');
 assert.equal(JSON.stringify(events).includes('987654'),false);
});
