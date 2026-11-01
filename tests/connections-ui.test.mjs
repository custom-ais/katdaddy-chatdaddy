import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/admin/SettingsPage.tsx', import.meta.url), 'utf8');
const when = source.slice(source.indexOf('const when ='), source.indexOf('\n\n', source.indexOf('const when =')));
const component = source.slice(source.indexOf('function RecordedHealth('), source.indexOf('\nfunction AccountIdentity('));
const compiled = ts.transpileModule(`${when}\nexport ${component}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('require', 'exports', compiled)(require, exports);
const render = (props) => renderToStaticMarkup(React.createElement(exports.RecordedHealth, props));

test('configuration alone is unverified; legacy errors are collapsed history', () => {
  const html = render({ configured: true, legacyIssue: { at: 1000, message: 'Old denied request' } });
  assert.match(html, /Configuration present · unverified/);
  assert.match(html, /Last checked: not yet recorded/);
  assert.match(html, /<details[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /Previous errors \(1\).*history only/);
  assert.doesNotMatch(html, /Active failure|last recorded check succeeded/);
});
test('healthy requires a recorded success and historical errors do not become active', () => {
  assert.match(render({ configured: true, health: { status: 'healthy' } }), /unverified/);
  const html = render({ configured: true, health: { status: 'healthy', checkedAt: 2000, lastSuccessAt: 2000, lastIssue: { at: 1000, message: 'Recovered error' } } });
  assert.match(html, /last recorded check succeeded/);
  assert.match(html, /Last success:/);
  assert.match(html, /Recovered error/);
  assert.doesNotMatch(html, /Active failure/);
});
test('active failure is distinct and duplicates are excluded from history', () => {
  const issue = { at: 2000, message: 'Current failure' }, old = { at: 1000, message: 'Earlier failure' };
  const html = render({ configured: true, health: { status: 'error', checkedAt: 2000, activeIssue: issue, lastIssue: issue, history: [issue, old, old] }, legacyIssue: issue });
  assert.match(html, /active recorded failure/);
  assert.match(html, /Active failure/);
  assert.match(html, /Previous errors \(1\)/);
  assert.equal((html.match(/Current failure/g) || []).length, 1);
});
test('unknown never treats stale activeIssue as current; missing configuration stays explicit', () => {
  const html = render({ configured: false, health: { status: 'unknown', activeIssue: { at: 1000, message: 'Stale' } } });
  assert.match(html, /Configuration missing/);
  assert.doesNotMatch(html, /Active failure/);
});
test('Connections uses recorded health rather than legacy issue absence and refreshes snapshot only', () => {
  assert.doesNotMatch(source, /configured && !i\.leadConnector\?\.issue|google' && !i\.maps\?\.issue/);
  assert.doesNotMatch(source, /LeadConnector|LC_PRIVATE_TOKEN|leadConnector/);
  assert.match(source, /i\.maps\?\.health\?\.status === 'healthy'/);
  assert.match(source, /onClick=\{\(\) => void refresh\(\)\}/);
  assert.match(source, /does not run external provider checks/);
  assert.match(source, /Required for safe booking state; no on\/off switch/);
});

const accountSource = source.slice(source.indexOf('function AccountIdentity('), source.indexOf('\nfunction Connections('));
const accountCode = ts.transpileModule(`${when}\nexport ${accountSource}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const accountExports = {};
new Function('require', 'exports', accountCode)(require, accountExports);
test('account identity requires explicit verified name; opaque config never infers identity', () => {
  const renderAccount = account => renderToStaticMarkup(React.createElement(accountExports.AccountIdentity, {account}));
  for (const account of [undefined, {}, {status:'unverified',displayName:'Do not claim'}, {status:'unavailable'}, {status:'verified'}]) assert.match(renderAccount(account), /Account name (?:not yet looked up|unavailable at the last lookup)/);
  assert.match(renderAccount({status:'verified',displayName:'Example Company',checkedAt:1000}), /Verified account name.*Example Company/);
});
test('account names refresh is explicit and separate from passive status refresh', () => {
  assert.ok(source.includes("api('/api/admin/integration-accounts', { method: 'POST', body: {} })"));
  assert.match(source, /onClick=\{\(\) => void refreshAccounts\(\)\}/);
  assert.match(source, /i\.accounts\?\.jobber/);
  assert.match(source, /Optional Jobber and Twilio account-name lookup only/);
});

test('connection switches edit draft integration config, with blocking warnings and no provider calls', () => {
  assert.ok(source.includes("onChange('integrations', { ...config.integrations, [key]: value })"));
  assert.ok(source.includes('!confirm(offWarning[key])'));
  for (const key of ['jobber','maps','verification','sms','email']) assert.match(source, new RegExp(`switchFor\\('${key}'`));
  assert.doesNotMatch(source, /switchFor\('database'/);
  assert.match(source, /Turning Jobber off pauses online booking/);
  assert.match(source, /pauses all online booking, including ZIP-based coverage/);
  assert.match(source, /never bypasses the code check/);
  assert.ok(source.includes('<Connections config={c} onChange={update} />'));
});
test('Verify and SMS remain visible unconfigured; provider selection and API costs are explicit', () => {
  assert.doesNotMatch(source, /i\.verification\?\.provider === 'twilio' \?/);
  assert.doesNotMatch(source, /i\.sms\?\.provider === 'twilio' \?/);
  assert.match(source, /assistant\?\.providers\?\.\[aiProvider\]/);
  assert.match(source, /onChange\('aiProvider', event.target.value\)/);
  assert.match(source, /<option value="gemini">Gemini<\/option>/);
  assert.match(source, /<option value="openai">OpenAI \(ChatGPT models\)<\/option>/);
  assert.match(source, /a ChatGPT subscription does not include API usage/);
  assert.match(source, /verified confirmation-email sender/);
});
test('rendered controls preserve other integration flags and decline disabling without changing drafts', () => {
  const toggles = [], fields = [], changes = []; let providerCalls = 0;
  const part = source.slice(source.indexOf('const when ='), source.indexOf('/** Edits are saved'));
  const prelude = `const {useState}=require('react'); const {useDashboard,api,Toggle,Field,Section,Dot,ErrorNote,Link2}=require('ui-test'); const inputClass='',subtleButton='',primaryButton='',secondaryButton='';`;
  const code = ts.transpileModule(`${prelude}\n${part}\nexport {Connections};`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const stubs = {
    useDashboard: () => ({ data: {integrations:{assistant:{providers:{gemini:{configured:true,model:'test'},openai:{configured:false}}}}}, refresh:()=>{providerCalls++;}, mutate:()=>{providerCalls++;}, showToast:()=>{}, loading:false }),
    api:()=>{providerCalls++;throw Error('No API call expected');},
    Toggle: props => {toggles.push(props);return React.createElement('span',null,props.label);},
    Field: props => {fields.push(props);return React.createElement('div',null,props.children);},
    Section: props => React.createElement('section',null,props.children), Dot:()=>null,ErrorNote:()=>null,Link2:()=>null,
  };
  const out={};new Function('require','exports',code)(id=>id==='ui-test'?stubs:require(id),out);
  const config={integrations:{jobber:true,maps:true,verification:true,sms:false},aiProvider:'gemini',aiAssistant:true};
  const html=renderToStaticMarkup(React.createElement(out.Connections,{config,onChange:(...args)=>changes.push(args)}));
  assert.doesNotMatch(html,/LeadConnector/); assert.match(html,/Twilio Verify/); assert.match(html,/Twilio appointment texts/); assert.match(html,/SendGrid appointment emails/); assert.match(html,/Unavailable: configure SendGrid/);
  const previousConfirm=globalThis.confirm;
  try {
    globalThis.confirm=()=>false;toggles.find(t=>t.label==='Enable Jobber').onChange(false);assert.equal(changes.length,0);
    globalThis.confirm=()=>true;toggles.find(t=>t.label==='Enable Jobber').onChange(false);
    assert.deepEqual(changes.shift(),['integrations',{jobber:false,maps:true,verification:true,sms:false}]);
    toggles.find(t=>t.label==='Enable Smart chat').onChange(false);assert.deepEqual(changes.shift(),['aiAssistant',false]);
    fields.find(f=>f.label==='Smart chat provider').children.props.onChange({target:{value:'openai'}});assert.deepEqual(changes.shift(),['aiProvider','openai']);
    toggles.find(t=>t.label==='Enable appointment emails').onChange(false);assert.deepEqual(changes.shift(),['integrations',{jobber:true,maps:true,verification:true,sms:false,email:false}]);
    assert.equal(providerCalls,0);
    assert.deepEqual(config.integrations,{jobber:true,maps:true,verification:true,sms:false});
  } finally {if(previousConfirm===undefined)delete globalThis.confirm;else globalThis.confirm=previousConfirm;}
});

 test('saved policy information and disabled Maps history do not imply active readiness', () => {
  assert.ok(source.includes("const verificationRequired = data.integrations?.verification?.provider === 'twilio' || c.requirePhoneVerification !== false"));
  assert.match(source, /checked=\{verificationRequired\} disabled/);
  assert.match(source, /Not required by the saved policy/);
  assert.match(source, /enabled\('maps'\) && i\.maps/);
  assert.match(source, /Recorded check history — not current enabled status/);
  assert.match(source, /enabled\('maps'\) \? <RecordedHealth/);
});

test('confirmation email status is independent of OTP and admin send actions support either channel', async () => {
  assert.match(source, /SendGrid appointment emails', false/);
  assert.match(source, /not the verification-code template/);
  assert.match(source, /i\.email\?\.configured/);
  assert.match(source, /c\.integrations\?\.email === false/);
  const detail = await readFile(new URL('../src/admin/AppointmentDetailModal.tsx', import.meta.url), 'utf8');
  assert.match(detail, />Send confirmation<\/button>/);
  assert.doesNotMatch(detail, /Resend confirmation|'Confirmation sent'/);
  assert.match(detail, /not confirmed delivery/);
  assert.match(detail, /failed_or_uncertain.*office review/);
  assert.match(detail, /email already attempted is not resent automatically/);
  assert.match(detail, /sms\?\.configured\) \|\| \(data\.integrations\?\.email\?\.enabled !== false && data\.integrations\?\.email\?\.configured/);
  const create = await readFile(new URL('../src/admin/NewAppointmentModal.tsx', import.meta.url), 'utf8');
  assert.match(create, /disabled=\{!smsReady && !emailReady\}/);
  assert.doesNotMatch(create, /Email confirmations are not available/);
});

const healthyOperation = { status: 'healthy', stale: false, checkedAt: 2000, lastSuccessAt: 2000 };
test('Maps partial recorded success distinguishes unused suggestions from successful routing and lookup', () => {
  const html = render({configured:true,health:{status:'unknown',lastSuccessAt:2000,operations:{geocode:healthyOperation,routes:healthyOperation,places:{status:'unknown',checkedAt:null}}}});
  assert.match(html,/Some recorded checks succeeded; other checks unverified\/stale/);
  assert.match(html,/Address lookup:<\/span> last recorded check succeeded/);
  assert.match(html,/Driving routes:<\/span> last recorded check succeeded/);
  assert.match(html,/Address suggestions:<\/span> never checked; unverified/);
  assert.doesNotMatch(html,/Configuration present · last recorded check succeeded/);
});
test('stale-only and all-unknown operation states never imply partial success', () => {
  for (const operation of [{...healthyOperation,status:'unknown',stale:true},{...healthyOperation,fresh:false},{status:'unknown'}]) {
    const html=render({configured:true,health:{status:'unknown',operations:{routes:operation}}});
    assert.match(html,/Configuration present · unverified/);
    assert.doesNotMatch(html,/Some recorded checks succeeded|Driving routes:<\/span> last recorded check succeeded/);
  }
});
test('active failure takes precedence over successful operations and missing configuration never claims success', () => {
  const health={status:'error',activeIssue:{at:2000,message:'Route unavailable'},operations:{geocode:healthyOperation,routes:{status:'error',activeIssue:{message:'Route unavailable'}},places:{status:'unknown'}}};
  const html=render({configured:true,health});
  assert.match(html,/active recorded failure/);assert.match(html,/Driving routes:<\/span> recorded failure/);
  assert.doesNotMatch(html,/Some recorded checks succeeded/);
  const missing=render({configured:false,health:{status:'unknown',operations:{routes:healthyOperation,places:{status:'unknown'}}}});
  assert.match(missing,/Configuration missing/);assert.match(missing,/Driving routes:<\/span> configuration missing; unverified/);
  assert.doesNotMatch(missing,/Some recorded checks succeeded|last recorded check succeeded/);
});

function renderConnections(config, integrations) {
  const part = source.slice(source.indexOf('const when ='), source.indexOf('/** Edits are saved'));
  const prelude = `const {useState}=require('react'); const {useDashboard,api,Toggle,Field,Section,Dot,ErrorNote,Link2}=require('status-test'); const inputClass='',subtleButton='',primaryButton='',secondaryButton='';`;
  const code = ts.transpileModule(`${prelude}\n${part}\nexport {Connections};`, {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
  const plain=({children,label,description})=>React.createElement('div',null,label,description,children);
  const stubs={useDashboard:()=>({data:{config:{integrations:{jobber:true,sms:true,verification:true,email:true,maps:true},aiAssistant:true,aiProvider:'gemini'},integrations},refresh:()=>{throw Error('No automatic calls');},mutate:()=>{throw Error('No automatic calls');}}),api:()=>{throw Error('No automatic calls');},Toggle:()=>null,Field:plain,Section:plain,Dot:()=>null,ErrorNote:plain,Link2:()=>null};
  const out={};new Function('require','exports',code)(id=>id==='status-test'?stubs:require(id),out);
  return renderToStaticMarkup(React.createElement(out.Connections,{config,onChange:()=>{}}));
}
test('configured connections have textual setup status distinct from delivery and optional identity lookup',()=>{
 const html=renderConnections({aiAssistant:true,aiProvider:'gemini'}, {jobber:{connected:true},verification:{configured:true},sms:{configured:true},email:{configured:true},assistant:{providers:{gemini:{configured:true}}},maps:{provider:'google'},database:'postgres'});
 assert.match(html,/>Connected<\/span>/);assert.equal((html.match(/>Configured<\/span>/g)||[]).length,6);
 assert.match(html,/not proven operation or delivery/);
 assert.equal((html.match(/Account name not yet looked up/g)||[]).length,3,'identity only Jobber and the two Twilio rows');
 assert.doesNotMatch(html,/Account identity not verified/);
});
test('off drafts and missing setup do not masquerade as working connections',()=>{
 const html=renderConnections({integrations:{sms:false,email:false},aiAssistant:false},{});
 assert.equal((html.match(/Off · unsaved draft/g)||[]).length,3);
 assert.match(html,/>Setup required<\/span>/);
 assert.doesNotMatch(html,/>Connected<\/span>|>Configured<\/span>/);
 assert.match(source,/Object\.prototype\.hasOwnProperty\.call\(accounts, name\)/);
});
test('account lookup unavailable includes last check without asserting transport failure',()=>{
 const html=renderToStaticMarkup(React.createElement(accountExports.AccountIdentity,{account:{status:'unavailable',checkedAt:1000}}));
 assert.match(html,/Account name unavailable at the last lookup/);assert.match(html,/checked/);assert.match(html,/not a connection or delivery test/);
});
test('fresh observed operations can be green without claiming message delivery; stale and draft cannot',()=>{
 const observed={sms:{status:'healthy',checkedAt:2000,lastSuccessAt:2000,stale:false},email:{status:'healthy',checkedAt:2000,lastSuccessAt:2000,stale:true},assistant:{status:'error',checkedAt:2000,stale:false}};
 const html=renderConnections({aiAssistant:true,aiProvider:'gemini'}, {sms:{configured:true},email:{configured:true},assistant:{providers:{gemini:{configured:true}}},observed});
 assert.equal((html.match(/Accepted recently — delivery unconfirmed/g)||[]).length,1);
 assert.match(html,/Recent operation failed/);assert.match(html,/Last operation:/);
 const draft=renderConnections({integrations:{sms:false}}, {sms:{configured:true},observed});
 assert.doesNotMatch(draft,/Accepted recently/);
 assert.match(source,/api\/admin\/connections\/refresh/);assert.match(source,/No test messages, AI requests or Maps calls/);
 assert.match(source,/https:\/\/console.twilio.com\//);assert.match(source,/https:\/\/app.sendgrid.com\//);
});
