import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as templates from '../shared/message-templates.mjs';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/admin/MessageTemplates.tsx',import.meta.url),'utf8');
const code=ts.transpileModule(source+'\nexport {TemplateEditor};',{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const out={};
const plain=({children,label,title,description,hint})=>React.createElement('div',null,label,title,description,hint,children);
new Function('require','exports',code)(id=>id==='../../shared/message-templates.mjs'?templates:id==='./ui'?{Field:plain,Section:plain,inputClass:'',secondaryButton:''}:id==='lucide-react'?{MessageSquare:()=>null}:require(id),out);
function find(node,predicate){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;}
test('four channel states roundtrip legacy booleans without enabling transport',()=>{
 for(const [state,sms,email] of [['off',false,false],['text',true,false],['email',false,true],['both',true,true]]){
  assert.equal(out.confirmationChannel({smsConfirmations:sms,emailConfirmations:email}),state);
  assert.deepEqual(out.confirmationChannelPatch(state),{smsConfirmations:sms,emailConfirmations:email});
 }
 const changes=[];const config={smsConfirmations:false,emailConfirmations:false,messageTemplates:{ownerBookingSms:'Preserve me'}};
 const tree=out.MessageTemplates({config,integrations:{},onPatch:patch=>changes.push(patch)});
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
 assert.doesNotMatch(source,/dangerouslySetInnerHTML|fetch\(|api\(|mutate\(/);
 assert.match(source,/onClick=\{\(\) => onChange\(''\)\}/);
 assert.match(source,/renderMessageTemplate\(value, samples, field\)/);
 const smsField=templates.MESSAGE_TEMPLATE_FIELDS.find(f=>f.key==='confirmationSms');
 assert.match(renderToStaticMarkup(React.createElement(out.TemplateEditor,{field:smsField,value:'Hi {{customer_name}}',onChange:()=>{}})),/Hi Alex Example Reply STOP to opt out\./);
});
test('Templates uses mounted shared Settings drafts and preserves Client Hub independent saving',async()=>{
 const settings=await readFile(new URL('../src/admin/SettingsPage.tsx',import.meta.url),'utf8');
 assert.match(settings,/\['templates', 'Templates'\]/);assert.match(settings,/hidden=\{page !== 'templates'\}/);
 assert.match(settings,/<MessageTemplates config=\{c\} integrations=\{data.integrations\} onPatch=/);
 assert.match(settings,/<ClientHubSettings \/>/);assert.match(source,/Verification codes and emergency approval requests are separate/);
});
