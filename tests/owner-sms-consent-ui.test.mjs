import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {OWNER_SMS_CONSENT_VERSION,OWNER_SMS_DISCLOSURE,OWNER_SMS_PURPOSES} from '../shared/owner-sms-consent.mjs';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('../src/admin/OwnerSmsConsent.tsx',import.meta.url),'utf8');
const compile=text=>ts.transpileModule(text,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const ui={};new Function('require','exports',compile(await readFile(new URL('../src/admin/ui.tsx',import.meta.url),'utf8')))(id=>id==='./DashboardContext'?{attentionReason:()=>null}:require(id),ui);
const base={revision:0,current:null,disclosure:{version:OWNER_SMS_CONSENT_VERSION,text:OWNER_SMS_DISCLOSURE,purposes:OWNER_SMS_PURPOSES},readiness:{stopHelpVerified:false,automaticActivation:false}};
function harness(snapshot=base,notice='', apiImpl=null) {
 const phone='+16235550100',states=[phone,false,snapshot,false,'',notice],calls=[];let cursor=0,refCursor=0;const refs=[];
 const react={...React,useState:init=>{const i=cursor++;if(!(i in states))states[i]=typeof init==='function'?init():init;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},useEffect:()=>{},useRef:init=>{const i=refCursor++;return refs[i]||(refs[i]={current:init});}};
 const deps={react,'./ui':ui,'./DashboardContext':{useDashboard:()=>({data:{config:{bookingOwnerSmsEnabled:true,bookingOwnerSmsPhone:phone}}})},'../components/PhoneInput':{PhoneInput:props=>React.createElement('input',{type:'tel',value:props.value,readOnly:true})},'../lib/api':{api:async(path,opts)=>{calls.push({path,...opts});if(apiImpl)return apiImpl(path,opts);return {...base,revision:1,current:{active:opts?.body?.action==='grant',phone,at:'2026-11-01T00:00:00Z',disclosureVersion:base.disclosure.version}};}}};
 const out={};new Function('require','exports',compile(source))(id=>deps[id]||require(id),out);
 const render=()=>{cursor=0;refCursor=0;return out.OwnerSmsConsent();};
 const find=(node,predicate)=>{if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of React.Children.toArray(node.props?.children)){const found=find(child,predicate);if(found)return found;}return null;};
 return {states,calls,render,find,button:(tree,label)=>find(tree,n=>n.type==='button'&&n.props.children===label)};
}
test('new consent never prechecks from existing owner toggle or receipt; clear planned-program gaps',()=>{
 const h=harness({...base,current:{active:true,phone:'+16235550100'}}),tree=h.render();
 assert.equal(h.find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);
 assert.equal(h.button(tree,'Save explicit consent').props.disabled,true);
 const html=renderToStaticMarkup(tree);assert.match(html,/Planned Custom-AIs program/);assert.match(html,/owner SMS privacy section and SMS program terms have been published/);assert.match(html,/STOP\/HELP sender behavior has not been verified/);assert.equal(h.calls.length,0);
});
test('explicit consent submits versioned receipt only and phone edits clear agreement',async()=>{
 const h=harness();let tree=h.render();h.find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();
 await h.button(tree,'Save explicit consent').props.onClick();assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].body.consent,true);assert.equal(h.calls[0].body.disclosureVersion,OWNER_SMS_CONSENT_VERSION);assert.equal(h.calls[0].body.revision,0);assert.ok(h.calls[0].body.idempotencyKey);
 assert.doesNotMatch(JSON.stringify(h.calls),/bookingOwnerSmsEnabled|smsConfirmations/);
 tree=h.render();assert.match(renderToStaticMarkup(tree),/No SMS was sent and alerts were not activated/);
 h.find(tree,n=>typeof n.props?.onValueChange==='function').props.onValueChange('(623) 555-0101');tree=h.render();assert.equal(h.find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);
});
test('revoke is receipt-only and phone mismatch cannot look effective',async()=>{
 const h=harness({...base,effectiveActive:false,matchesConfiguredPhone:false,current:{active:true,phone:'+16235550100'}});let tree=h.render();assert.match(renderToStaticMarkup(tree),/not effective for the configured phone/);
 await h.button(tree,'Revoke recorded consent').props.onClick();assert.equal(h.calls[0].body.action,'revoke');assert.equal(h.calls[0].body.consent,undefined);assert.match(renderToStaticMarkup(h.render()),/Consent revoked/);
});
test('write explicitly labelled local rendered preview artifact without live consent',async()=>{
 const form=renderToStaticMarkup(harness().render());
 const saved=renderToStaticMarkup(harness({...base,current:{active:true,phone:'+16235550100',at:'2026-11-01T00:00:00Z',disclosureVersion:OWNER_SMS_CONSENT_VERSION}},'Consent saved. No SMS was sent and alerts were not activated. Owner SMS is held pending separate Custom-AIs setup and activation.').render());
 const html=`<!doctype html><meta charset="utf-8"><title>Local preview — Custom-AIs owner consent</title><style>body{font:16px system-ui;background:#f1f5f9;color:#172033;max-width:900px;margin:30px auto;padding:20px}section,body>div{background:white;padding:24px;margin:20px 0;border-radius:20px}button,input{font:inherit;margin:8px;padding:8px}button:disabled{opacity:.5}p{line-height:1.5}h1{color:#9a3412}</style><h1>LOCAL PREVIEW — SAMPLE DATA ONLY</h1><p>Actual component server-rendered for review. Not published. No live consent recorded, no texts sent. Controls in this static file do not submit.</p><h2>Proposed form</h2>${form}<h2>Simulated saved confirmation — not a real receipt</h2>${saved}`;
 await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
 await writeFile(new URL('../artifacts/owner-sms-consent-local-preview.html',import.meta.url),html);
});

test('late receipt loads cannot overwrite grant results or changed phone, and refresh clears affirmation',async()=>{
 let finishGet;const h=harness(base,'',(path,opts)=>opts?.method==='POST'?Promise.resolve({...base,revision:5,current:{active:true,phone:'+16235550100'}}):new Promise(resolve=>{finishGet=resolve;}));
 let tree=h.render();h.find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();
 h.button(tree,'Refresh consent receipt').props.onClick();tree=h.render();assert.equal(h.find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.checked,false);
 h.find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});tree=h.render();await h.button(tree,'Save explicit consent').props.onClick();
 finishGet({...base,revision:1});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.states[2].revision,5);assert.match(h.states[5],/Consent saved/);
 tree=h.render();h.button(tree,'Refresh consent receipt').props.onClick();tree=h.render();h.find(tree,n=>typeof n.props?.onValueChange==='function').props.onValueChange('(623) 555-0102');
 finishGet({...base,revision:2});await new Promise(resolve=>setImmediate(resolve));assert.equal(h.states[2].revision,5);assert.equal(h.states[0],'(623) 555-0102');assert.equal(h.states[1],false);
 assert.match(source,/mounted.current = false; generation.current\+\+/);
});

test('initial loading prevents phone edits and offers retry even without a snapshot',async()=>{
 const h=harness(null,'',()=>Promise.resolve(base));let tree=h.render();
 assert.equal(h.find(tree,n=>typeof n.props?.onValueChange==='function').props.disabled,true);
 await h.button(tree,'Retry loading consent form').props.onClick();await new Promise(resolve=>setImmediate(resolve));
 tree=h.render();assert.equal(h.find(tree,n=>typeof n.props?.onValueChange==='function').props.disabled,false);assert.ok(h.states[2].disclosure);
});

test('published policy links are exact without claiming verified public access or HELP',()=>{
 const html=renderToStaticMarkup(harness().render());
 assert.match(html,/href="https:\/\/custom-ais\.com\/privacy#sms-privacy"/);assert.match(html,/href="mailto:support@custom-ais\.com"/);
 assert.match(html,/href="https:\/\/custom-ais\.com\/sms-terms"/);
 assert.match(html,/not verified SMS HELP handling/);assert.match(html,/public accessibility has not been confirmed/);
 assert.doesNotMatch(source,/acceptedTerms/);
 assert.doesNotMatch(html,/owner SMS update is pending review|program terms are not yet available|unpublished SMS terms/);
});

test('refresh after an external-tab revocation clears the old grant notice',async()=>{
 const granted={...base,revision:1,current:{active:true,phone:'+16235550100'}};
 const revoked={...granted,revision:2,current:{...granted.current,active:false}};
 const h=harness(granted,'Consent saved. No SMS was sent.',()=>Promise.resolve(revoked));
 h.button(h.render(),'Refresh consent receipt').props.onClick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.states[2].revision,2);assert.equal(h.states[2].current.active,false);assert.equal(h.states[5],'');
 assert.match(renderToStaticMarkup(h.render()),/inactive or revoked/);
 assert.doesNotMatch(renderToStaticMarkup(h.render()),/Consent saved/);
});

test('unchanged and failed refreshes preserve the current submit confirmation',async()=>{
 const granted={...base,revision:1,current:{active:true,phone:'+16235550100'}};
 const notice='Consent saved. No SMS was sent.';let fail=false;
 const h=harness(granted,notice,()=>fail?Promise.reject(new Error('Receipt refresh failed')):Promise.resolve(granted));
 for(let attempt=0;attempt<2;attempt++){
  h.button(h.render(),'Refresh consent receipt').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.states[5],notice);assert.equal(h.states[2].revision,1);
 }
 fail=true;h.button(h.render(),'Refresh consent receipt').props.onClick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.states[4],'Receipt refresh failed');assert.equal(h.states[5],notice);assert.equal(h.states[2].revision,1);
 fail=false;h.button(h.render(),'Refresh consent receipt').props.onClick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.states[4],'');assert.equal(h.states[5],notice);
});

test('out-of-order refreshes cannot restore an obsolete receipt or success notice',async()=>{
 const granted={...base,revision:1,current:{active:true,phone:'+16235550100'}};
 const pending=[];const h=harness(granted,'Consent saved.',()=>new Promise(resolve=>pending.push(resolve)));
 h.button(h.render(),'Refresh consent receipt').props.onClick();h.button(h.render(),'Refresh consent receipt').props.onClick();
 pending[1]({...granted,revision:2,current:{...granted.current,active:false}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.states[5],'');assert.equal(h.states[2].revision,2);
 pending[0](granted);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(h.states[5],'');assert.equal(h.states[2].revision,2);assert.equal(h.states[2].current.active,false);
});
