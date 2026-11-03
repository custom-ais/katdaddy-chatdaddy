import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseDocument} from 'htmlparser2';
import * as consent from '../shared/owner-sms-consent.mjs';
import * as phoneDisplay from '../shared/phone-display.mjs';
const {OWNER_SMS_CONSENT_VERSION,OWNER_SMS_DISCLOSURE,OWNER_SMS_PURPOSES,OWNER_SMS_TERMS_URL,OWNER_SMS_PRIVACY_URL}=consent;
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/admin/OwnerSmsConsent.tsx',import.meta.url),'utf8');
const compile=text=>ts.transpileModule(text,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const ui={};new Function('require','exports',compile(await readFile(new URL('../src/admin/ui.tsx',import.meta.url),'utf8')))(id=>id==='./DashboardContext'?{attentionReason:()=>null}:require(id),ui);
const EXPECTED_DISCLOSURE='I control this mobile number and agree to receive recurring automated text messages from Custom-AIs ChatDaddy Owner Alerts about successful ChatDaddy bookings, after-hours emergency requests that need my answer, and service errors that need my attention. These are not marketing messages. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. SMS Terms: https://custom-ais.com/sms-terms Privacy Policy: https://custom-ais.com/privacy';
const GRANTED='Consent saved. Owner alerts will go to this number while Owner booking alerts are on.';
const WITHDRAWN='Consent withdrawn. No owner alerts will be sent to this number.';
const phone='+16235550100',at='2026-11-02T17:00:00Z';
const base={revision:0,current:null,currentVersion:false,matchesConfiguredPhone:false,effectiveActive:false,disclosure:{version:OWNER_SMS_CONSENT_VERSION,text:OWNER_SMS_DISCLOSURE,purposes:[...OWNER_SMS_PURPOSES],termsUrl:OWNER_SMS_TERMS_URL,privacyUrl:OWNER_SMS_PRIVACY_URL}};
const receipt=(overrides={})=>({id:'synthetic-receipt',revision:1,action:'grant',active:true,phone,at,disclosureVersion:OWNER_SMS_CONSENT_VERSION,disclosure:OWNER_SMS_DISCLOSURE,purposes:[...OWNER_SMS_PURPOSES],actor:{type:'authenticated_admin_user',userId:'synthetic-owner',reference:'synthetic-reference'},requestFingerprint:'synthetic-fingerprint',...overrides});
const saved=(overrides={})=>({...base,revision:1,current:receipt(),currentVersion:true,matchesConfiguredPhone:true,effectiveActive:true,...overrides});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const domAll=(node,predicate)=>[...(predicate(node)?[node]:[]),...(node.children||[]).flatMap(child=>domAll(child,predicate))];
const textContent=node=>node.type==='text'?node.data:(node.children||[]).map(textContent).join('');
function harness(snapshot=base,notice='',apiImpl=null){
 let configuredPhone=phone,cursor=0,refCursor=0,effectCursor=0;const states=[phone,false,snapshot,false,'',notice],calls=[],refs=[],effects=[];
 const react={...React,useState:init=>{const i=cursor++;if(!(i in states))states[i]=typeof init==='function'?init():init;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},useEffect:fn=>{effects[effectCursor++]=fn;},useRef:init=>{const i=refCursor++;return refs[i]||(refs[i]={current:init});}};
 const deps={react,'./ui':ui,'../../shared/owner-sms-consent.mjs':consent,'../../shared/phone-display.mjs':phoneDisplay,'./DashboardContext':{useDashboard:()=>({data:{config:{bookingOwnerSmsEnabled:true,bookingOwnerSmsPhone:configuredPhone}}})},'../components/PhoneInput':{PhoneInput:props=>React.createElement('input',{type:'tel',value:props.value,disabled:props.disabled,readOnly:true})},'../lib/api':{api:async(path,opts)=>{calls.push({path,...opts});if(apiImpl)return apiImpl(path,opts);return opts?.method==='POST'?saved({effectiveActive:opts.body.action==='grant',current:receipt({active:opts.body.action==='grant',action:opts.body.action})}):snapshot;}}};
 const out={};new Function('require','exports',compile(source))(id=>deps[id]||require(id),out);
 const render=()=>{cursor=0;refCursor=0;effectCursor=0;return out.OwnerSmsConsent();};
 const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;};
 const checkbox=tree=>find(tree,n=>n.type==='input'&&n.props.type==='checkbox');
 return {states,calls,render,find,checkbox,effects,configured:value=>{configuredPhone=value;},button:(tree,label)=>find(tree,n=>n.type==='button'&&n.props.children===label),agree(){checkbox(render()).props.onChange({target:{checked:true}});}};
}
test('exact approved copy renders one unchecked checkbox whose linked visible label equals the stored disclosure character for character',()=>{
 const h=harness(saved()),tree=h.render(),doc=parseDocument(renderToStaticMarkup(tree));
 assert.equal(OWNER_SMS_DISCLOSURE,EXPECTED_DISCLOSURE);
 assert.equal(tree.props.title,'Custom-AIs ChatDaddy Owner Alerts — text message consent');
 assert.equal(tree.props.description,'Optional. Check the box below to get text alerts on this phone. You can withdraw consent here at any time or reply STOP to any alert.');
 const field=h.find(tree,n=>n.props?.label==='Mobile number for owner alerts');
 assert.equal(field.props.hint,'Must match the number saved in Owner booking alerts above. A different number needs new consent.');
 const checkboxes=domAll(doc,n=>n.name==='input'&&n.attribs.type==='checkbox');assert.equal(checkboxes.length,1);assert.equal(Object.hasOwn(checkboxes[0].attribs,'checked'),false);
 const label=domAll(doc,n=>n.name==='label').find(n=>domAll(n,c=>c.name==='input'&&c.attribs.type==='checkbox').length);
 assert.equal(textContent(label),EXPECTED_DISCLOSURE);
 const links=domAll(label,n=>n.name==='a');assert.deepEqual(links.map(n=>[n.attribs.href,textContent(n)]),[[OWNER_SMS_TERMS_URL,OWNER_SMS_TERMS_URL],[OWNER_SMS_PRIVACY_URL,OWNER_SMS_PRIVACY_URL]]);
 assert.equal(domAll(doc,n=>n.name==='a').length,3);const footer=domAll(doc,n=>n.name==='p').at(-1);assert.equal(textContent(footer),'Questions? Email support@custom-ais.com.');assert.equal(domAll(footer,n=>n.name==='a')[0].attribs.href,'mailto:support@custom-ais.com');
 assert.equal(textContent(doc).split(EXPECTED_DISCLOSURE).length-1,1);
 for(const label of ['Save consent','Withdraw consent','Refresh status'])assert.ok(h.button(tree,label));
 assert.doesNotMatch(textContent(doc),/planned program|setup review|not been verified|public accessibility|held pending|readiness|not activated|not verified SMS HELP|I control this number and explicitly/i);
 assert.doesNotMatch(renderToStaticMarkup(tree),/planned|not verified|readiness|held pending|has not been confirmed|intended to|must be verified/i);
 assert.equal(h.calls.length,0);
});
test('checkbox uses the returned snapshot text rather than substituting a different local disclosure',()=>{
 const text='Synthetic server text. '+OWNER_SMS_TERMS_URL+' '+OWNER_SMS_PRIVACY_URL;
 const tree=harness({...base,disclosure:{...base.disclosure,text}}).render();const doc=parseDocument(renderToStaticMarkup(tree));
 const label=domAll(doc,n=>n.name==='label').find(n=>domAll(n,c=>c.name==='input'&&c.attribs.type==='checkbox').length);
 assert.equal(textContent(label),text);
});
test('consent is never prechecked from a toggle, current receipt, old receipt, or revoked receipt',()=>{
 for(const snapshot of [base,saved(),saved({currentVersion:false,current:receipt({disclosureVersion:'v1'})}),saved({current:receipt({active:false})})]){
  const h=harness(snapshot),tree=h.render();assert.equal(h.checkbox(tree).props.checked,false);assert.equal(h.button(tree,'Save consent').props.disabled,true);assert.equal(h.button(tree,'Withdraw consent').props.disabled,!snapshot.current?.active);
 }
});
test('status uses exact copy with old-version precedence, number mismatch, formatted phone/date, withdrawn date and terms version',()=>{
 const cases=[
  [saved(),'Consent on file for (623) 555-0100 since November 2, 2026.'],
  [saved({currentVersion:false,matchesConfiguredPhone:false,current:receipt({disclosureVersion:'v1'})}),'Consent on file uses an older version of these terms. Check the box and save again to receive alerts.'],
  [saved({matchesConfiguredPhone:false}),'Consent on file is for a different number. Save consent for the number above to receive alerts.'],
  [saved({currentVersion:false,matchesConfiguredPhone:false,current:receipt({active:false,action:'revoke'})}),'Consent withdrawn on November 2, 2026.'],
 ];
 for(const [snapshot,expected]of cases){const doc=parseDocument(renderToStaticMarkup(harness(snapshot).render()));const paragraphs=domAll(doc,n=>n.name==='p').map(textContent);assert.ok(paragraphs.includes(expected));assert.ok(paragraphs.includes('Terms version: '+snapshot.current.disclosureVersion));if(!snapshot.currentVersion)assert.equal(paragraphs.some(p=>p.startsWith('Consent on file for (')),false);}
});
test('save requires affirmation and number; grant carries only the explicit versioned receipt and resets affirmation',async()=>{
 const h=harness();let tree=h.render();h.button(tree,'Save consent').props.onClick();assert.equal(h.calls.length,0);
 h.agree();h.states[0]=' ';assert.equal(h.button(h.render(),'Save consent').props.disabled,true);h.states[0]=phone;
 assert.equal(h.button(h.render(),'Save consent').props.disabled,false);h.button(h.render(),'Save consent').props.onClick();await flush();
 assert.equal(h.calls.length,1);assert.deepEqual(Object.keys(h.calls[0].body).sort(),['action','consent','disclosureVersion','idempotencyKey','phone','revision']);assert.equal(h.calls[0].body.consent,true);assert.equal(h.calls[0].body.disclosureVersion,OWNER_SMS_CONSENT_VERSION);assert.equal(h.calls[0].body.revision,0);assert.equal(h.states[1],false);assert.equal(h.states[5],GRANTED);
 assert.doesNotMatch(JSON.stringify(h.calls),/bookingOwnerSmsEnabled|smsConfirmations|sendingAuthorized/);
});
test('withdrawal is receipt-only, uses exact notice and resets affirmation',async()=>{
 const h=harness(saved());h.agree();h.button(h.render(),'Withdraw consent').props.onClick();await flush();assert.equal(h.calls[0].body.action,'revoke');assert.equal(h.calls[0].body.consent,undefined);assert.equal(h.states[1],false);assert.equal(h.states[5],WITHDRAWN);assert.equal(h.states[2].current.active,false);
});
test('successful grant responses with newer withdrawn, old-version or mismatched snapshots do not claim alerts will go',async()=>{
 const cases=[
  [saved({revision:2,effectiveActive:false,current:receipt({revision:2,active:false,action:'revoke'})}),'Consent withdrawn on November 2, 2026.'],
  [saved({revision:2,effectiveActive:false,currentVersion:false,current:receipt({revision:2,disclosureVersion:'older-version'})}),'Consent on file uses an older version of these terms.'],
  [saved({revision:2,effectiveActive:false,matchesConfiguredPhone:false,current:receipt({revision:2})}),'Consent on file is for a different number.'],
 ];
 for(const [latest,status]of cases){
  const result={...latest,receipt:receipt()};const h=harness(base,'',()=>result);h.agree();h.button(h.render(),'Save consent').props.onClick();await flush();
  assert.equal(h.states[2],result);assert.equal(h.states[5],'');assert.equal(h.states[1],false);
  const text=textContent(parseDocument(renderToStaticMarkup(h.render())));assert.ok(text.includes(status));assert.equal(text.includes(GRANTED),false);
 }
});
test('successful withdrawal superseded by a new grant displays the latest receipt without a withdrawn confirmation',async()=>{
 const result={...saved({revision:3,current:receipt({revision:3})}),receipt:receipt({revision:2,active:false,action:'revoke'})};
 const h=harness(saved(),GRANTED,()=>result);h.button(h.render(),'Withdraw consent').props.onClick();await flush();
 assert.equal(h.states[2],result);assert.equal(h.states[5],'');
 const text=textContent(parseDocument(renderToStaticMarkup(h.render())));assert.ok(text.includes('Consent on file for (623) 555-0100 since November 2, 2026.'));assert.equal(text.includes(WITHDRAWN),false);
});
test('phone edits clear consent and notices without changing configured recipient',()=>{
 const h=harness(saved(),GRANTED);h.agree();h.find(h.render(),n=>typeof n.props?.onValueChange==='function').props.onValueChange('(623) 555-0101');assert.equal(h.states[0],'(623) 555-0101');assert.equal(h.states[1],false);assert.equal(h.states[5],'');assert.equal(h.calls.length,0);
});
test('configured recipient changes reset phone, affirmation and notice then reload the receipt',async()=>{
 const h=harness(saved(),GRANTED,()=>saved({matchesConfiguredPhone:false,effectiveActive:false}));h.agree();h.configured('+16235550102');h.render();h.effects[1]();await flush();assert.equal(h.states[0],'+16235550102');assert.equal(h.states[1],false);assert.equal(h.states[5],'');assert.equal(h.calls[0].path,'/api/admin/owner-sms-consent');
});
test('late receipt loads cannot overwrite a newer grant or edited phone, and refresh clears affirmation',async()=>{
 let finishGet;const h=harness(base,'',(_path,opts)=>opts?.method==='POST'?Promise.resolve(saved({revision:5})):new Promise(resolve=>{finishGet=resolve;}));
 h.agree();h.button(h.render(),'Refresh status').props.onClick();assert.equal(h.states[1],false);h.agree();h.button(h.render(),'Save consent').props.onClick();await flush();finishGet(saved());await flush();assert.equal(h.states[2].revision,5);assert.equal(h.states[5],GRANTED);
 h.button(h.render(),'Refresh status').props.onClick();h.find(h.render(),n=>typeof n.props?.onValueChange==='function').props.onValueChange('(623) 555-0102');finishGet(saved({revision:2}));await flush();assert.equal(h.states[2].revision,5);assert.equal(h.states[0],'(623) 555-0102');assert.equal(h.states[1],false);
});
test('initial loading disables the phone and retries after a failed disclosure load',async()=>{
 let fail=true;const h=harness(null,'',()=>fail?Promise.reject(new Error('Synthetic load failed')):Promise.resolve(base));let tree=h.render();assert.equal(h.find(tree,n=>typeof n.props?.onValueChange==='function').props.disabled,true);
 h.button(tree,'Retry loading consent form').props.onClick();await flush();assert.equal(h.states[4],'Synthetic load failed');assert.equal(h.states[2],null);assert.ok(h.button(h.render(),'Retry loading consent form'));
 fail=false;h.button(h.render(),'Retry loading consent form').props.onClick();await flush();assert.equal(h.states[4],'');assert.equal(h.find(h.render(),n=>typeof n.props?.onValueChange==='function').props.disabled,false);assert.equal(h.states[1],false);
});
test('refresh after external withdrawal clears the outdated save notice',async()=>{
 const h=harness(saved(),GRANTED,()=>saved({revision:2,effectiveActive:false,current:receipt({active:false,action:'revoke',revision:2})}));h.button(h.render(),'Refresh status').props.onClick();await flush();assert.equal(h.states[5],'');assert.equal(h.states[2].current.active,false);assert.match(renderToStaticMarkup(h.render()),/Consent withdrawn on November 2, 2026/);
});
test('same-revision terms or configured-number changes clear a stale success notice',async()=>{
 for(const change of [{currentVersion:false,effectiveActive:false},{matchesConfiguredPhone:false,effectiveActive:false}]){const h=harness(saved(),GRANTED,()=>saved(change));h.button(h.render(),'Refresh status').props.onClick();await flush();assert.equal(h.states[5],'');}
});
test('unchanged and failed refreshes preserve a valid current submit confirmation',async()=>{
 let fail=false;const h=harness(saved(),GRANTED,()=>fail?Promise.reject(new Error('Synthetic refresh failed')):Promise.resolve(saved()));
 for(let i=0;i<2;i++){h.button(h.render(),'Refresh status').props.onClick();await flush();assert.equal(h.states[5],GRANTED);assert.equal(h.states[2].revision,1);}
 fail=true;h.button(h.render(),'Refresh status').props.onClick();await flush();assert.equal(h.states[4],'Synthetic refresh failed');assert.equal(h.states[5],GRANTED);
 fail=false;h.button(h.render(),'Refresh status').props.onClick();await flush();assert.equal(h.states[4],'');assert.equal(h.states[5],GRANTED);
});
test('out-of-order refreshes cannot restore an obsolete receipt or confirmation',async()=>{
 const pending=[];const h=harness(saved(),GRANTED,()=>new Promise(resolve=>pending.push(resolve)));h.button(h.render(),'Refresh status').props.onClick();h.button(h.render(),'Refresh status').props.onClick();pending[1](saved({revision:2,current:receipt({active:false})}));await flush();pending[0](saved());await flush();assert.equal(h.states[5],'');assert.equal(h.states[2].revision,2);assert.equal(h.states[2].current.active,false);
});
test('repeated submit while pending performs one request and a failed save never shows success',async()=>{
 let reject;const h=harness(base,'',()=>new Promise((_resolve,no)=>{reject=no;}));h.agree();const button=h.button(h.render(),'Save consent');button.props.onClick();button.props.onClick();assert.equal(h.calls.length,1);assert.equal(h.states[3],true);assert.equal(h.checkbox(h.render()).props.disabled,true);
 reject(new Error('Synthetic interrupted save'));await flush();assert.equal(h.states[3],false);assert.equal(h.states[2],base);assert.equal(h.states[4],'Synthetic interrupted save');assert.equal(h.states[5],'');
});
test('unmount during submission prevents receipt or notice updates',async()=>{
 let finish;const h=harness(base,'',()=>new Promise(resolve=>{finish=resolve;}));h.render();const cleanup=h.effects[0]();h.agree();h.button(h.render(),'Save consent').props.onClick();cleanup();finish(saved());await flush();assert.equal(h.states[2],base);assert.equal(h.states[5],'');
});
