import test from 'node:test';
import assert from 'node:assert/strict';
import {renderHtmlTemplate,validateHtmlTemplate} from '../server/email-html.mjs';
import {confirmationEmail} from '../server/messages.mjs';
test('HTML uses safe formatting, escaped one-pass variables and readable plain alternative',()=>{
 const r=renderHtmlTemplate('<h2>Hello {{customer_name}}</h2><p style="color:#123456;font-weight:bold">Details<br>Next</p><ul><li>First</li></ul>',{customer_name:'<img src=x onerror=alert(1)> {{company_name}}'});
 assert.match(r.html, /&lt;img/);assert.ok(!r.html.includes('<img'));assert.match(r.text,/Details\nNext/);assert.match(r.text,/• First/);assert.match(r.text,/\{\{company_name\}\}/);
});
test('active tags, images, unsafe links, style network and CSS expression are removed',()=>{
 const r=renderHtmlTemplate('<script>alert(1)</script><svg><script>bad()</script></svg><math><mi>bad</mi></math><iframe>bad</iframe><form><input><p onclick="bad()">Safe</p></form><img src="https://example.com/pixel"><a href="javascript:alert(1)">Bad link</a><p style="background-image:url(https://evil.test);color:expression(alert(1));position:fixed;--x:url(https://evil.test)">End</p>',{});
 for(const bad of ['<script','<svg','<math','<iframe','<form','<input','<img','onclick','javascript:','url(','expression(','position:','--x'])assert.ok(!r.html.includes(bad),bad);
 assert.ok(!r.text.includes('alert(1)'));assert.match(r.text,/Safe/);
});
test('variables in attribute/tag/script/comment contexts reject instead of unsafe guessing',()=>{
 for(const html of ['<{{service}}>X</{{service}}>','<a {{service}}="x">X</a>','<p style="color:{{service}}">X</p>','<a href="https://example.com/{{service}}">X</a>','<a href="{{customer_name}}">X</a>','<script>{{service}}</script>','<!--{{service}}--><p>X</p>','<p>{{unknown}}</p>'])assert.ok(validateHtmlTemplate(html).length,html);
});
test('Client Hub variable only valid resolved URL survives attribute rendering; raw settings do not supply it',()=>{
 for(const input of ['','javascript:alert(1)','https://evil.example/','https://clienthub.getjobber.com/" onclick="bad()']){
 const r=renderHtmlTemplate('<a href="{{client_hub_url}}">Open Client Hub</a>',{client_hub_url:input});assert.ok(!r.html.includes('href='),r.html);
 }
 for (const host of ['clienthub.getjobber.com','%63lienthub.getjobber.com','clienthub%2egetjobber.com','%63lienthub.getjobber.com.','%63lienthub%2egetjobber%2ecom%2e','ｃｌｉｅｎｔｈｕｂ.getjobber.com.']) assert.ok(validateHtmlTemplate('<a href="https://' + host + '/">Hub</a>').length);
});
test('malformed markup, entity protocol tricks and URL CSS never create executable output',()=>{
 assert.throws(()=>renderHtmlTemplate('<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">Safe',{}),/readable text/);
 for(const html of ['<p>Safe<svg/onload=alert(1)><a href="jav&#x61;script:alert(1)">Link</a>','<p style="color: red; background: u\\72l(https://evil.example);">Safe</p>','<a href="//evil.example">Safe</a>']){
 const r=renderHtmlTemplate(html,{});assert.ok(!/<(?:img|svg|math|script|style)\b/i.test(r.html));assert.ok(!/onerror=|onload=|href="(?:javascript:|\/\/)|url\(/i.test(r.html));
 }
});
test('plain mode and blank HTML mode preserve legacy output; HTML mode derives plaintext',()=>{
 const a={id:'DVS-X',customerName:'Alex',package:'Cleaning',scheduledAt:'2026-11-02T18:00:00Z',price:179,address:'Test',city:'Phoenix',zip:'85000',route:'cleaning'};const c={preparation:'Prepare',businessName:'Test'};
 assert.deepEqual(confirmationEmail(a,{...c,messageEmailFormat:'html',messageTemplates:{confirmationEmailBody:' '}}),confirmationEmail(a,c));
 const custom={...c,messageTemplates:{confirmationEmailBody:'<p>Hello {{customer_name}}</p>'}};
 assert.match(confirmationEmail(a,custom).html,/&lt;p&gt;/);
 assert.equal(confirmationEmail(a,{...custom,messageEmailFormat:'html'}).text,'Hello Alex');
});
