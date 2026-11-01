import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClientHubUrl } from '../shared/client-hub.mjs';
import { confirmationEmail, confirmationSms, verificationSms } from '../server/messages.mjs';
const base = 'https://clienthub.getjobber.com/client_hubs/12345678-1234-1234-1234-123456789abc/login/new';
const url = base + '?source=share_login';
const appt = {customerName:'Example Client',package:'Cleaning',scheduledAt:'2026-11-04T17:00:00Z',price:99,id:'example',address:'123 Main',city:'Phoenix',zip:'85001'};
const config = {preparation:'Clear a path'};
test('public company login URL normalized; empty optional', () => {
 assert.equal(normalizeClientHubUrl(base),url); assert.equal(normalizeClientHubUrl(url),url); assert.equal(normalizeClientHubUrl(''),'');
});
test('rejects private tokens, URL injection, unexpected hosts and query abuse', () => {
 for(const value of [url+'&token=secret',base+'?source=share_login&source=share_login',base+'?token=abc',base+'#x',base.replace('https:','http:'),base.replace('clienthub.','evil.'),base.replace('.com/','.com.evil/'),base.replace('https://','https://user:pass@'),base.replace('.com/','.com:443/'),base.replace('/login/new','/login/token'),base+'\n', ' '+base,base.replace('/login/','/%6cogin/'),base.replace('/login/','/../login/'),{url}]) assert.throws(()=>normalizeClientHubUrl(value),undefined,String(value));
});
test('confirmation HTML button and plaintext receive only resolved public URL', () => {
 const email=confirmationEmail(appt,config,{clientHubUrl:url});
 assert.match(email.html,/Open Client Hub/); assert.ok(email.html.includes(`href="${url}"`)); assert.ok(email.text.includes(url));
 assert.equal(confirmationEmail(appt,{...config,clientHubUrl:url}).html.includes(url),false);
 for(const bad of ['', 'javascript:alert(1)',url+'&token=secret']) {const e=confirmationEmail(appt,config,{clientHubUrl:bad});assert.equal(e.html.includes('Open Client Hub'),false);assert.equal(e.text.includes('Open Client Hub'),false);}
});
test('SMS confirmation and OTP are unchanged and never include hub link',()=>{
 assert.equal(confirmationSms(appt,{...config,clientHubUrl:url}).includes('clienthub'),false);
 assert.equal(verificationSms('1234').includes('clienthub'),false);
});
