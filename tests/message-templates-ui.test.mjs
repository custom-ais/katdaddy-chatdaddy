import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseDocument} from 'htmlparser2';
import * as templates from '../shared/message-templates.mjs';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/admin/MessageTemplates.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source+'\nexport {TemplateEditor};',{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const out={};
const plain=({children,label,title,description,hint})=>React.createElement('div',null,label,title,description,hint,children);
new Function('require','exports',code)(id=>id==='../../shared/message-templates.mjs'?templates:id==='../lib/api'?{api:()=>{throw new Error('Unexpected request');}}:id==='./ui'?{Field:plain,Section:plain,inputClass:'',secondaryButton:''}:id==='lucide-react'?{MessageSquare:()=>null}:require(id),out);
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
test('four channel states roundtrip legacy booleans without enabling transport',()=>{
 for(const [state,sms,email] of [['off',false,false],['text',true,false],['email',false,true],['both',true,true]]){
  assert.equal(out.confirmationChannel({smsConfirmations:sms,emailConfirmations:email}),state);
  assert.deepEqual(out.confirmationChannelPatch(state),{smsConfirmations:sms,emailConfirmations:email});
 }
 const changes=[];const config={smsConfirmations:false,emailConfirmations:false,messageTemplates:{ownerBookingSms:'Preserve me'}};
 const tree=out.MessageTemplates({config,integrations:{},allowOwner:true,allowMessaging:true,onPatch:patch=>changes.push(patch)});
 find(tree,node=>node.type==='select').props.onChange({target:{value:'both'}});
 assert.deepEqual(changes,[{smsConfirmations:true,emailConfirmations:true}]);assert.equal(config.messageTemplates.ownerBookingSms,'Preserve me');
 const html=renderToStaticMarkup(tree);assert.match(html,/unavailable or disabled/);assert.match(html,/does not enable or configure/);assert.match(html,/Texts require customer consent/);
});
test('variable insertion preserves selection boundaries and caret',()=>{
 assert.deepEqual(out.insertTemplateVariable('Hi Alex!',3,7,'customer_name'),{value:'Hi {{customer_name}}!',caret:20});
 assert.equal(out.insertTemplateVariable('Hi ',3,3,'service').value,'Hi {{service}}');
 assert.match(source,/selectionStart/);assert.match(source,/setSelectionRange/);
});
test('sample preview is escaped plaintext, validates variables, and blank uses existing default',()=>{
 const field=templates.MESSAGE_TEMPLATE_FIELDS.find(f=>f.key==='confirmationEmailBody');
 const render=value=>renderToStaticMarkup(React.createElement(out.TemplateEditor,{field,value,onChange:()=>{}}));
 assert.match(render('Hello {{customer_first_name}} <script>alert(1)</script>'),/Hello Alex &lt;script&gt;/);
 assert.doesNotMatch(render('Hello {{customer_first_name}} <script>alert(1)</script>'),/<script>/);
 assert.match(render('{{not_supported}}'),/unknown variable/);
 assert.match(render(''),/Built-in default will be used/);
 assert.doesNotMatch(source,/dangerouslySetInnerHTML|fetch\(|mutate\(/);
 assert.match(source,/onClick=\{\(\) => change\(''\)\}/);
 assert.match(source,/renderMessageTemplate\(value, samples, field\)/);
 const smsField=templates.MESSAGE_TEMPLATE_FIELDS.find(f=>f.key==='confirmationSms');
 assert.match(renderToStaticMarkup(React.createElement(out.TemplateEditor,{field:smsField,value:'Hi {{customer_name}}',onChange:()=>{}})),/Hi Alex Example Reply STOP to opt out\./);
});
test('owner SMS campaign hint is exact and does not appear on customer templates or for a restricted user',()=>{
 const hint='Start with "Custom-AIs ChatDaddy alert:" and end with "Reply STOP to opt out." to match the registered campaign.';
 const text=node=>node.type==='text'?node.data:(node.children||[]).map(text).join('');
 const renderField=key=>text(parseDocument(renderToStaticMarkup(React.createElement(out.TemplateEditor,{field:templates.MESSAGE_TEMPLATE_FIELDS.find(field=>field.key===key),value:'',onChange(){}}))));
 assert.ok(renderField('ownerBookingSms').includes(hint));assert.equal(renderField('confirmationSms').includes(hint),false);
 const hidden=renderToStaticMarkup(out.MessageTemplates({config:{messageTemplates:{}},integrations:{},allowOwner:false,allowMessaging:true,onPatch(){}}));
 assert.equal(text(parseDocument(hidden)).includes(hint),false);assert.doesNotMatch(hidden,/Owner booking SMS/);
});
test('Templates uses mounted shared Settings drafts and preserves Client Hub independent saving',async()=>{
 const settings=await readFile(new URL('../src/admin/SettingsPage.tsx',import.meta.url),'utf8');
 assert.match(settings,/\['templates', 'Templates'\]/);assert.match(settings,/hidden=\{page !== 'templates'\}/);
 assert.match(settings,/<MessageTemplates config=\{c\} integrations=\{data.integrations\} allowOwner=\{can\('ownerSms.manage'\)\} allowMessaging=\{can\('integrations.manage'\)\} onPatch=/);
 assert.match(settings,/<ClientHubSettings \/>/);assert.match(source,/Verification codes and emergency approval requests are separate/);
});

test('HTML format selector keeps drafts and only patches the explicit format',()=>{
 const changes=[];const config={messageTemplates:{confirmationEmailBody:'<p>Preserved body</p>'},messageEmailFormat:'plain'};
 const tree=out.MessageTemplates({config,integrations:{},allowOwner:true,allowMessaging:true,onPatch:p=>changes.push(p)});
 const mode=find(tree,node=>node.type==='select'&&node.props.value==='plain');assert.ok(mode);
 mode.props.onChange({target:{value:'html'}});assert.deepEqual(changes,[{messageEmailFormat:'html'}]);
 assert.equal(config.messageTemplates.confirmationEmailBody,'<p>Preserved body</p>');
 const html=renderToStaticMarkup(tree);assert.match(html,/Changing mode keeps your current body text/);
});
test('HTML mode has explicit sanitized preview action and never embeds raw editor content',()=>{
 const field=templates.MESSAGE_TEMPLATE_FIELDS.find(f=>f.key==='confirmationEmailBody');
 const html=renderToStaticMarkup(React.createElement(out.TemplateEditor,{field,value:'<script>bad()</script>',emailFormat:'html',onChange:()=>{}}));
 assert.match(html,/Preview HTML safely/);assert.match(html,/unsupported elements/);assert.doesNotMatch(html,/<iframe|<script>/);
 assert.match(source,/version === generation.current && source === currentSource.current/);
 assert.match(source,/useEffect.*clearPreview/);assert.match(source,/clearPreview\(\); onChange\(next\)/);
});
test('sanitized preview iframe is isolated, noninteractive and blocks remote assets',()=>{
 const html=renderToStaticMarkup(React.createElement(out.SanitizedEmailPreview,{html:'<p>Safe preview</p>',text:'Safe preview'}));
 assert.match(html,/sandbox=""/);assert.match(html,/inert=""/);assert.match(html,/pointer-events-none/);assert.match(html,/referrerPolicy="no-referrer"/i);
 assert.doesNotMatch(html,/allow-scripts|allow-same-origin|allow-forms/);
 const doc=out.emailPreviewDocument('<p>Safe preview</p>');assert.ok(doc.indexOf('Content-Security-Policy')<doc.indexOf('<p>'));
 for(const rule of ["default-src 'none'","style-src 'unsafe-inline'","script-src 'none'","img-src 'none'","connect-src 'none'","frame-src 'none'","form-action 'none'","base-uri 'none'"])assert.ok(doc.includes(rule));
 assert.match(html,/Plain-text alternative/);
});
test('preview requests use only fictional-template endpoint and validate returned sanitized shape',async()=>{
 const calls=[];const request=async(...args)=>{calls.push(args);return {html:'<p>Alex</p>',text:'Alex'};};
 assert.deepEqual(await out.requestHtmlPreview('<p>{{customer_first_name}}</p>',request),{html:'<p>Alex</p>',text:'Alex'});
 assert.deepEqual(calls,[['/api/admin/templates/preview',{method:'POST',body:{template:'<p>{{customer_first_name}}</p>'}}]]);
 await assert.rejects(out.requestHtmlPreview('x',async()=>({html:'x'})),/unavailable/);
});
test('editing or switching format discards stale asynchronous HTML previews',async()=>{
 const slots=[];let cursor=0;const pending=[];
 const hooks={...React,
  useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},
  useRef(initial){const i=cursor++;return slots[i]||(slots[i]={current:initial});},
  useEffect(effect,deps){const i=cursor++;if(!slots[i]||deps.some((v,j)=>v!==slots[i][j])){slots[i]=deps;effect();}},
 };
 const component={};new Function('require','exports',code)(id=>id==='react'?hooks:id==='../../shared/message-templates.mjs'?templates:id==='../lib/api'?{api:()=>new Promise(resolve=>pending.push(resolve))}:id==='./ui'?{Field:plain,Section:plain,inputClass:'',secondaryButton:''}:id==='lucide-react'?{MessageSquare:()=>null}:require(id),component);
 const field=templates.MESSAGE_TEMPLATE_FIELDS.find(f=>f.key==='confirmationEmailBody');
 const render=(value,emailFormat='html')=>{cursor=0;return component.TemplateEditor({field,value,emailFormat,onChange:()=>{}});};
 const previewButton=tree=>find(tree,n=>n.type==='button'&&n.props.children==='Preview HTML safely');
 const first=render('<p>Old</p>');const oldRequest=previewButton(first).props.onClick();
 find(first,n=>n.type==='textarea').props.onChange({target:{value:'<p>New</p>'}});render('<p>New</p>');
 pending.shift()({html:'<p>Old sanitized</p>',text:'Old'});await oldRequest;
 let current=render('<p>New</p>');assert.equal(find(current,n=>n.type===component.SanitizedEmailPreview),null);
 const newRequest=previewButton(current).props.onClick();pending.shift()({html:'<p>New sanitized</p>',text:'New'});await newRequest;
 current=render('<p>New</p>');assert.equal(find(current,n=>n.type===component.SanitizedEmailPreview).props.html,'<p>New sanitized</p>');
 assert.equal(find(render('<p>New</p>','plain'),n=>n.type===component.SanitizedEmailPreview),null);
});
