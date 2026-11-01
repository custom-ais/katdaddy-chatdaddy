import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from './helpers.mjs';
import {withConfigDefaults,validateConfig,DEFAULT_CONFIG} from '../shared/domain.mjs';
test('old settings retain plain email mode and invalid modes fail validation',()=>{
 assert.equal(withConfigDefaults({}).messageEmailFormat,'plain');
 assert.ok(validateConfig({...DEFAULT_CONFIG,messageEmailFormat:'javascript'}).some(x=>/plain text or HTML/.test(x)));
});
test('HTML preview is authenticated, fictional, sanitized and does not save settings',async t=>{
 const h=await harness(t);const before=await h.store.config();
 assert.ok((await h.call('/api/admin/templates/preview',{method:'POST',body:{template:'<p>Hello</p>'}})).status>=400);
 const cookie=await h.login();
 const result=await h.call('/api/admin/templates/preview',{method:'POST',cookie,body:{template:'<p>Hello {{customer_first_name}}</p><script>alert(1)</script>'}});
 assert.equal(result.status,200,JSON.stringify(result.data));assert.match(result.data.html,/Alex/);assert.doesNotMatch(result.data.html,/<script/i);assert.match(result.data.text,/Alex/);
 assert.equal((await h.store.config()).version,before.version);
 const bad=await h.call('/api/admin/templates/preview',{method:'POST',cookie,body:{template:'<a href="{{customer_name}}">bad</a>'}});
 assert.equal(bad.status,400);
 const empty=await h.call('/api/admin/templates/preview',{method:'POST',cookie,body:{template:'<script>alert(1)</script>'}});assert.equal(empty.status,400);
});
test('HTML settings context rejects unsafe placeholder placement and preserves plain text configuration',async t=>{
 const h=await harness(t);const cookie=await h.login(),c=await h.store.config();
 const bad=await h.call('/api/admin/config',{method:'PATCH',cookie,body:{...c,messageEmailFormat:'html',messageTemplates:{...c.messageTemplates,confirmationEmailBody:'<a href="{{customer_name}}">bad</a>'}}});
 assert.equal(bad.status,400);
 assert.equal((await h.store.config()).messageEmailFormat,'plain');
 const empty=await h.call('/api/admin/config',{method:'PATCH',cookie,body:{...c,messageEmailFormat:'html',messageTemplates:{...c.messageTemplates,confirmationEmailBody:'<script>alert(1)</script>'}}});
 assert.equal(empty.status,400);
 const good=await h.call('/api/admin/config',{method:'PATCH',cookie,body:{...c,messageEmailFormat:'html',messageTemplates:{...c.messageTemplates,confirmationEmailBody:'<p>Hello {{customer_name}}</p>'}}});
 assert.equal(good.status,200,JSON.stringify(good.data));assert.equal((await h.store.config()).messageEmailFormat,'html');
});
