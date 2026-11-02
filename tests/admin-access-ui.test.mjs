import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'htmlparser2';
import * as permissions from '../shared/admin-permissions.mjs';
import * as domain from '../shared/domain.mjs';
import * as catalog from '../shared/catalog.mjs';
import * as coverage from '../shared/coverage.mjs';
const require = createRequire(import.meta.url);
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
async function load(file, deps={}) {
  const out={};new Function('require','exports',compile(await readFile(new URL(`../src/admin/${file}`,import.meta.url),'utf8')))(id=>deps[id]||require(id),out);return out;
}
const access=await load('access.ts',{'../../shared/admin-permissions.mjs':permissions});
const member=(keys=[])=>({id:'synthetic-member',role:'member',permissions:keys,name:'Synthetic Member'});
const ui={
 Field:({label,children})=>React.createElement('label',null,label,children),
 Section:({title,description,action,children})=>React.createElement('section',null,React.createElement('h3',null,title),description,action,children),
 Toggle:({label,detail,checked,disabled})=>React.createElement('label',null,React.createElement('input',{type:'checkbox',checked:!!checked,disabled,readOnly:true}),label,detail),
 ErrorNote:({children})=>React.createElement('p',{role:'alert'},children),
};

test('initial navigation selects first allowed page while explicit denied and unknown links never fall back to appointments',()=>{
 const principal=member(['settings.business.view']);
 assert.equal(access.initialAdminTab('',principal),'settings');
 assert.equal(access.initialAdminTab('?tab=appointments',principal),'appointments');
 assert.equal(permissions.canViewTab(principal,'appointments'),false);
 assert.equal(access.initialAdminTab('?tab=unknown',principal),null);
 assert.equal(access.initialAdminTab('',member()),null);
 assert.equal(access.firstAllowedSettings(principal,[['connections','Connections'],['business','Business'],['security','Security']]),'business');
 assert.equal(permissions.canViewTab(undefined,'appointments'),false);
});

test('sparse config patch includes only changed nested leaves and preserves hidden or redacted settings',()=>{
 const before={version:4,phone:'Synthetic office',messageTemplates:{confirmationEmailBody:'old'},integrations:{sms:false},serviceZips:['12345'],bookingOwnerSmsPhone:'private'};
 const draft=structuredClone(before);draft.messageTemplates.confirmationEmailBody='new';
 assert.deepEqual(access.changedConfig(before,draft),{messageTemplates:{confirmationEmailBody:'new'}});
 assert.deepEqual(access.changedConfig(before,{...before,version:5}),{});
 assert.deepEqual(access.changedConfig({version:4,phone:'old'},{version:4,phone:'new'}),{phone:'new'});
 assert.equal(Object.hasOwn(access.changedConfig(before,draft),'bookingOwnerSmsPhone'),false);
});

test('invitation capture only uses explicit invite mode and fragment token',()=>{
 assert.deepEqual(access.invitationLocation({search:'?invite=1',hash:'#token=synthetic-token'}),{kind:'invite',token:'synthetic-token'});
 assert.deepEqual(access.invitationLocation({search:'?bootstrap=1',hash:'#token=synthetic-owner'}),{kind:'bootstrap',token:'synthetic-owner'});
 assert.deepEqual(access.invitationLocation({search:'?invite=1&token=query-secret',hash:''}),{kind:'invite',token:''});
 assert.equal(access.invitationLocation({search:'?tab=users',hash:'#token=ignored'}),null);
});

test('permission editor maintains page prerequisites and cannot select master capabilities',async()=>{
 const component=await load('UsersPage.tsx',{'../../shared/admin-permissions.mjs':permissions,'./DashboardContext':{},'../lib/api':{},'./ui':ui});
 assert.deepEqual(new Set(component.updatePermissionSelection([],'appointments.manage',true)),new Set(['appointments.manage','appointments.view']));
 const templ=component.updatePermissionSelection([],'settings.templates.manage',true);
 assert.ok(templ.includes('settings.templates.view'));assert.ok(templ.includes('finance.view'));
 assert.deepEqual(component.updatePermissionSelection(templ,'finance.view',false),[]);
 assert.deepEqual(component.updatePermissionSelection([],'users.manage',true),[]);
 assert.deepEqual(component.updatePermissionSelection([],'unknown.manage',true),[]);
});

test('navigation hides denied tabs, account management and office booking for a view-only member',async()=>{
 const principal=member(['appointments.view']);
 const component=await load('Header.tsx',{'../../shared/admin-permissions.mjs':permissions,'./DashboardContext':{useDashboard:()=>({data:{access:principal,appointments:[],requests:[],approvals:[],config:{},integrations:{}},can:key=>permissions.hasPermission(principal,key),loading:false,refresh(){}})}});
 const html=renderToStaticMarkup(React.createElement(component.Header,{tab:'appointments',onTab(){},onNew(){},onSignOut(){}}));
 assert.match(html,/Appointments/);assert.doesNotMatch(html,/Office booking|BOB activity|>Users<|>Settings<|>Analytics<|>Inbox</);
});

async function settings(principal,search){
 const mounted=[];
 const data={access:principal,config:structuredClone(domain.DEFAULT_CONFIG),technicians:[],faqs:[],integrations:{},appointments:[],requests:[],approvals:[]};
 data.config.bookingOwnerSmsPhone='PRIVATE-OWNER-NUMBER';
 const context={data,can:key=>permissions.hasPermission(principal,key),mutate(){throw new Error('Unexpected mutation');},refresh(){},loading:false,showToast(){}};
 const component=await load('SettingsPage.tsx',{
  react:{...React,lazy:()=>()=>null},
  '../../shared/admin-permissions.mjs':permissions,'./access':access,'./DashboardContext':{useDashboard:()=>context},'./ui':ui,
  '../../shared/domain.mjs':domain,'../../shared/catalog.mjs':catalog,'../../shared/coverage.mjs':coverage,
  '../lib/api':{api(){throw new Error('Unexpected request');}},'../components/PhoneInput':{PhoneInput:({onValueChange,...props})=>React.createElement('input',{...props,readOnly:true})},
  './OwnerSmsConsent':{OwnerSmsConsent:()=>{mounted.push('owner');return React.createElement('p',null,'OWNER-CONSENT-CONTENT');}},
  './ClientHubSettings':{ClientHubSettings:()=>{mounted.push('client-hub');return null;}},
  './MessageTemplates':{MessageTemplates:props=>{mounted.push(['templates',props.allowOwner,props.allowMessaging]);return null;}},
 });
 const prior=globalThis.location;globalThis.location={search,hash:'',origin:'http://synthetic.example'};
 try{return {html:renderToStaticMarkup(React.createElement(component.SettingsPage,{active:false})),mounted};}finally{globalThis.location=prior;}
}

test('denied settings panels and owner/provider components never mount for a business viewer',async()=>{
 const {html,mounted}=await settings(member(['settings.business.view']),'?tab=settings&settings=business');
 assert.match(html,/data-settings-panel="business"/);assert.match(html,/fieldset disabled/);
 assert.doesNotMatch(html,/data-settings-panel="(?:connections|booking|schedule|services|coverage|answers|templates|security)"/);
 assert.doesNotMatch(html,/PRIVATE-OWNER-NUMBER|OWNER-CONSENT-CONTENT|Download backup/);assert.deepEqual(mounted,[]);
});

test('connection status access mounts no provider management or account lookup controls',async()=>{
 const {html,mounted}=await settings(member(['settings.connections.view']),'?tab=settings&settings=connections');
 assert.match(html,/Connection status/);assert.match(html,/Refresh recorded status/);
 assert.doesNotMatch(html,/Refresh account names|Connect Jobber account|Disconnect account|Enable appointment texts|Client Hub link/);
 assert.deepEqual(mounted,[]);
});

test('direct denied settings URL shows denial rather than mounting the restricted panel',async()=>{
 const {html,mounted}=await settings(member(['settings.business.view']),'?tab=settings&settings=booking');
 assert.match(html,/You do not have access to this settings page/);assert.doesNotMatch(html,/data-settings-panel="booking"/);assert.deepEqual(mounted,[]);
});

test('legacy owner alert settings remain available but only a named Master mounts the consent form',async()=>{
 const legacy=await settings({id:'legacy',role:'legacy',permissions:[]},'?tab=settings&settings=booking');
 assert.match(legacy.html,/Owner booking alerts/);assert.match(legacy.html,/Your mobile number for booking alerts/);
 assert.match(legacy.html,/PRIVATE-OWNER-NUMBER/);
 assert.doesNotMatch(legacy.html,/owner-sms-consent|OWNER-CONSENT-CONTENT/);
 assert.equal(legacy.mounted.includes('owner'),false);
 const master=await settings({id:'synthetic-master',role:'master',permissions:[]},'?tab=settings&settings=booking');
 assert.match(master.html,/id="owner-sms-consent"/);assert.match(master.html,/OWNER-CONSENT-CONTENT/);
 assert.equal(master.mounted.filter(value=>value==='owner').length,1);
 const staff=await settings(member(['settings.booking.view','settings.booking.manage']),'?tab=settings&settings=booking');
 assert.doesNotMatch(staff.html,/Owner booking alerts|owner-sms-consent|OWNER-CONSENT-CONTENT/);
 assert.equal(staff.mounted.includes('owner'),false);
});

test('owner alert controls use the exact consent-dependent copy and service-error toggle remains off and protected',async()=>{
 const {html}=await settings({id:'synthetic-master',role:'master',permissions:[]},'?tab=settings&settings=booking');
 const all=(node,predicate)=>[...(predicate(node)?[node]:[]),...(node.children||[]).flatMap(child=>all(child,predicate))];
 const text=node=>node.type==='text'?node.data:(node.children||[]).map(text).join('');
 const doc=parseDocument(html),labels=all(doc,node=>node.name==='label');
 assert.ok(text(doc).includes('Optional texts to you after ChatDaddy confirms an appointment, and when something needs your attention. These are separate from emergency same-day approval requests and never hold up a booking.'));
 const booking=labels.find(node=>text(node).startsWith('Text me when an appointment is booked'));
 assert.equal(text(booking),'Text me when an appointment is bookedOff by default. Also needs the text message consent below for this number and an approved Twilio sender. Saving this setting does not send a test text.');
 const errors=labels.find(node=>text(node).startsWith('Text me about service errors'));
 assert.equal(text(errors),"Text me about service errorsOff by default. Texts you when a ChatDaddy booking needs your review, a customer can't finish booking because of a Jobber error, or the Jobber, phone-code, AI or email connection fails. At most one text per problem every 6 hours and 10 per day. Uses the number below and needs the text message consent below.");
 assert.equal(Object.hasOwn(all(errors,node=>node.name==='input')[0].attribs,'checked'),false);
 const staff=await settings(member(['settings.booking.view','settings.booking.manage']),'?tab=settings&settings=booking');
 assert.doesNotMatch(staff.html,/Text me about service errors|Text me when an appointment is booked/);
});

test('non-master technician editing cannot change or remove the reserved SMS recipient',async()=>{
 const source=await readFile(new URL('../src/admin/SettingsPage.tsx',import.meta.url),'utf8');
 const part=source.slice(source.indexOf('function Technicians('),source.indexOf('\nfunction Answers('));
 const changes=[];
 const techs=[{id:'tech-ryan',name:'Synthetic reserved technician',phone:'+16235550100',color:'#123456',status:'available'},{id:'tech-other',name:'Synthetic other technician',phone:'+16235550101',color:'#654321',status:'available'}];
 const PhoneInput=()=>null;const icon=()=>null;const out={};
 const deps={react:{...React,useState:()=>[null,()=>{}],useEffect:()=>{}},fixture:{useDashboard:()=>({data:{integrations:{},appointments:[]},can:()=>false}),PhoneInput,Section:ui.Section,Field:ui.Field,Users:icon,Plus:icon,Trash2:icon,api:()=>{throw Error('Unexpected request');}}};
 const prelude="const {useState,useEffect}=require('react');const {useDashboard,PhoneInput,Section,Field,Users,Plus,Trash2,api}=require('fixture');const inputClass='',secondaryButton='',subtleButton='';";
 new Function('require','exports',compile(prelude+'export '+part))(id=>deps[id]||require(id),out);
 const tree=out.Technicians({techs,onChange:value=>changes.push(value)});
 const all=[];function walk(node){if(!node||typeof node!=='object')return;all.push(node);for(const child of React.Children.toArray(node.props?.children))walk(child);}walk(tree);
 const phones=all.filter(node=>node.type===PhoneInput);
 assert.equal(phones[0].props.disabled,true);assert.equal(phones[1].props.disabled,false);
 phones[0].props.onValueChange('+16235550199');assert.equal(changes.length,0);
 const removals=all.filter(node=>node.type==='button'&&React.Children.toArray(node.props.children).includes('Remove'));
 assert.equal(removals[0].props.disabled,true);removals[0].props.onClick();assert.equal(changes.length,0);
 const bios=all.filter(node=>node.type==='textarea');
 assert.equal(bios.length,2);assert.ok(bios.every(node=>node.props.disabled&&node.props.placeholder==='Restricted'));
 bios[0].props.onChange({target:{value:'Unpermitted bio edit'}});assert.equal(changes.length,0);
 phones[1].props.onValueChange('+16235550198');assert.equal(changes[0][1].phone,'+16235550198');
 tree.props.action.props.onClick();assert.ok(changes.at(-1).at(-1).id.startsWith('tech-'));assert.notEqual(changes.at(-1).at(-1).id,'tech-ryan');
 assert.ok(all.some(node=>node.props?.hint==='Master Admin controls this SMS recipient number.'));
});
