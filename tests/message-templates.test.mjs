import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMessageTemplates, renderMessageTemplate, messageTemplateValues, DEFAULT_MESSAGE_TEMPLATES } from '../shared/message-templates.mjs';
import { confirmationSms, confirmationEmail, ownerBookingSms } from '../server/messages.mjs';
const appt = { id:'DVS-test',customerName:'Alex Example',package:'Cleaning',scheduledAt:'2026-11-02T18:00:00Z',price:179,address:'100 Example St',city:'Phoenix',zip:'85000',route:'cleaning' };
const config = { businessName:'Actual Company',phone:'+16235550100',preparation:'Clear a path.' };
test('validates known fields/variables and rejects malformed/unknown/overlong/injected subjects', () => {
  assert.deepEqual(validateMessageTemplates(DEFAULT_MESSAGE_TEMPLATES), []);
  for (const values of [{unknown:''},{confirmationSms:'{{unknown}}'},{confirmationSms:'{{ customer_name }}'},{confirmationSms:'{customer_name}'},{confirmationSms:'{{customer_name}'},{confirmationSms:'x'.repeat(1201)},{confirmationEmailSubject:'Bad\nSubject'},{confirmationSms:'{{client_hub_url}}'},{confirmationEmailSubject:'{{client_hub_url}}'},{ownerBookingSms:'{{client_hub_url}}'}]) assert.ok(validateMessageTemplates(values).length);
  assert.deepEqual(validateMessageTemplates({confirmationEmailBody:'Visit {{client_hub_url}}'}), []);
});
test('substitution is one-pass only, never evaluates expressions, and subject values cannot inject controls', () => {
  assert.equal(renderMessageTemplate('{{customer_name}}', {customer_name:'{{company_name}}',company_name:'secret'}),'{{company_name}}');
  assert.throws(()=>renderMessageTemplate('{{process.env.KEY}}',{}));
  assert.equal(renderMessageTemplate('{{customer_name}}',{customer_name:'Bad\r\nBcc: other\u0000'},{subject:true}),'Bad Bcc: other ');
});
test('values reflect actual booked data in Arizona timezone without raw configured Hub URL', () => {
  const values=messageTemplateValues(appt,{...config,clientHubUrl:'https://evil.example'});
  assert.equal(values.company_name,'Actual Company'); assert.equal(values.customer_first_name,'Alex');
  assert.equal(values.appointment_time,'11:00 AM Arizona time'); assert.equal(values.total,'$179.00');
  assert.equal(values.client_hub_url,''); assert.equal(messageTemplateValues(appt,config,{clientHubUrl:'javascript:alert(1)'}).client_hub_url,'');
});
test('blank templates preserve exact legacy SMS/email/owner copy', () => {
  const blank={...config,messageTemplates:DEFAULT_MESSAGE_TEMPLATES};
  assert.equal(confirmationSms(appt,blank),confirmationSms(appt,config));
  assert.deepEqual(confirmationEmail(appt,blank),confirmationEmail(appt,config));
  assert.equal(ownerBookingSms(appt,blank),ownerBookingSms(appt,config));
});
test('custom customer SMS always retains STOP footer and bounded rendered length', () => {
  const c={...config,messageTemplates:{confirmationSms:'Hi {{customer_first_name}}, {{service}} {{booking_reference}}.'}};
  assert.equal(confirmationSms(appt,c),'Hi Alex, Cleaning DVS-test. Reply STOP to opt out.');
  assert.throws(()=>confirmationSms({...appt,customerName:'A'.repeat(2000)},c),/too long/);
});
test('custom body is plain text; both literal markup and customer values are escaped in HTML', () => {
  const c={...config,messageTemplates:{confirmationEmailSubject:'Booked {{service}}',confirmationEmailBody:'<script>bad()</script>\nHi {{customer_name}}'}};
  const result=confirmationEmail({...appt,customerName:'<img src=x onerror=bad()>'},c);
  assert.equal(result.subject,'Booked Cleaning');
  assert.match(result.html,/&lt;script&gt;/); assert.match(result.html,/<br>/); assert.ok(!result.html.includes('<script>'));assert.ok(!result.html.includes('<img'));
  assert.match(result.text,/<script>/);
});
test('email subject/body can customize independently and owner variables use existing appointment', () => {
  const original=confirmationEmail(appt,config);
  assert.equal(confirmationEmail(appt,{...config,messageTemplates:{confirmationEmailSubject:'Ref {{booking_reference}}'}}).html,original.html);
  assert.equal(confirmationEmail(appt,{...config,messageTemplates:{confirmationEmailBody:'Hi'}}).subject,original.subject);
  assert.equal(ownerBookingSms(appt,{...config,messageTemplates:{ownerBookingSms:'Booked {{customer_name}}: {{booking_reference}}'}}),'Booked Alex Example: DVS-test');
});
