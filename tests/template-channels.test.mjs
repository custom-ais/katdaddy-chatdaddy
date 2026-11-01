import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,contact} from './helpers.mjs';
import {DEFAULT_CONFIG,withConfigDefaults,validateConfig} from '../shared/domain.mjs';

test('template defaults clone safely and server validates templates without changing legacy channels',()=>{
 const c=withConfigDefaults({smsConfirmations:false,emailConfirmations:false});assert.equal(c.smsConfirmations,false);assert.equal(c.emailConfirmations,false);
 c.messageTemplates.confirmationSms='changed';assert.equal(DEFAULT_CONFIG.messageTemplates.confirmationSms,'');
 assert.equal(withConfigDefaults({messageTemplates:{confirmationSms:'Hello'}}).messageTemplates.confirmationEmailBody,'');
 for(const templates of [{confirmationSms:'{{unknown}}'},{confirmationSms:'x'.repeat(20000)},null,{bad:'field'}])assert.ok(validateConfig({...DEFAULT_CONFIG,messageTemplates:templates}).length>0);
});
for(const [sms,email,consent] of [[true,false,true],[false,true,false],[true,true,true],[false,false,true],[true,false,false]])test(`confirmation channels sms=${sms} email=${email} consent=${consent} stay independent and deduplicated`,async t=>{
 const sendgrid={configured:true,calls:[],async sendEmail(to,content){this.calls.push({to,...content});return {status:'accepted'};}};
 const h=await harness(t,{sendgrid,env:{BOOKING_EMAIL_PROVIDER:'sendgrid'},config:{smsConfirmations:sms,emailConfirmations:email}});
 const r=await h.book('cleaning',{...contact,email:'test@example.test',smsConsent:consent});assert.equal(r.status,201,JSON.stringify(r.data));
 const texts=()=>h.twilio.calls.filter(x=>x[0]==='sms');assert.equal(texts().length,Number(sms&&consent));assert.equal(sendgrid.calls.length,Number(email));
 if(sms&&consent){assert.match(texts()[0][2],/STOP/);assert.match(r.data.receipt.notification,/accepted for delivery/);}
 const cookie=await h.login();
 for(let i=0;i<2;i++)assert.equal((await h.call(`/api/admin/appointments/${r.data.receipt.id}/confirmation`,{method:'POST',cookie,body:{}})).status,200);
 assert.equal(texts().length,Number(sms&&consent));assert.equal(sendgrid.calls.length,Number(email));
});

test('legacy known attempted SMS and email do not send again after transport migration',async t=>{
 const sendgrid={configured:true,calls:[],async sendEmail(){this.calls.push(1);return {status:'accepted'};}};
 const h=await harness(t,{sendgrid,env:{BOOKING_EMAIL_PROVIDER:'sendgrid'},config:{smsConfirmations:false,emailConfirmations:false}});
 const booked=await h.book('cleaning',{...contact,email:'test@example.test',smsConsent:true});assert.equal(booked.status,201);
 const cookie=await h.login();const config=await h.store.config();
 const a=(await h.store.appointments())[0];a.notifications={sms:'sent',email:'failed'};await h.store.updateAppointment(a);
 assert.equal((await h.call(`/api/admin/appointments/${a.id}/confirmation`,{method:'POST',cookie,body:{}})).status,200);
 await h.store.set('config',{...config,smsConfirmations:true,emailConfirmations:true});
 for(let i=0;i<2;i++)assert.equal((await h.call(`/api/admin/appointments/${a.id}/confirmation`,{method:'POST',cookie,body:{}})).status,200);
 assert.equal(h.twilio.calls.filter(x=>x[0]==='sms').length,0);assert.equal(sendgrid.calls.length,0);
});
