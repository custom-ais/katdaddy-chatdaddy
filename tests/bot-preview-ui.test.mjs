import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/admin/AdminRoot.tsx', import.meta.url), 'utf8');
const part = source.slice(source.indexOf('function BotPreview()'), source.indexOf('\nexport function adminTabFromSearch'));
const code = ts.transpileModule(`const {useDashboard,BookingBot,Bot,ExternalLink}=require('preview-test'); const secondaryButton=''; export ${part}`, {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
function render(snapshot) {
  const exports = {};
  const stubs = {useDashboard:()=>({data:{config:{bookingEnabled:true,aiAssistant:true},integrations:{},...snapshot}}),BookingBot:()=>null,Bot:()=>null,ExternalLink:()=>null};
  new Function('require','exports',code)(name=>name==='preview-test'?stubs:require(name),exports);
  return renderToStaticMarkup(React.createElement(exports.BotPreview));
}
test('preview live warning follows authoritative server flag, not local configuration guesses', () => {
  const configured = {jobber:{connected:true},verification:{provider:'twilio',configured:true,enabled:true},maps:{enabled:true,provider:'google'}};
  for (const bookingEnabled of [false,undefined]) {
    const html=render({bookingEnabled,integrations:configured});
    assert.match(html,/Online booking is off right now/);
    assert.doesNotMatch(html,/a booking you finish here is real/);
  }
  assert.match(render({bookingEnabled:true,config:{bookingEnabled:false}}),/a booking you finish here is real/);
});
test('preview distinguishes disabled maps from enabled Census lookup without claiming measured routes',()=>{
  assert.match(render({integrations:{maps:{enabled:false,provider:'google'}}}),/off — online booking is paused, including ZIP-based service areas/);
  const census=render({integrations:{maps:{enabled:true,provider:'census'}}});
  assert.match(census,/Census lookup only; measured routes unavailable/);
  assert.doesNotMatch(census,/Google Maps enabled|straight.line/);
});
test('verification policy is independent of appointment SMS and cannot disable selected Twilio',()=>{
  assert.match(render({config:{requirePhoneVerification:false},integrations:{verification:{provider:'none'}}}),/not required by the saved policy/);
  for (const smsConfirmations of [true,false]) {
    const html=render({config:{requirePhoneVerification:false,smsConfirmations},integrations:{verification:{provider:'twilio',configured:true,enabled:true},sms:{enabled:false}}});
    assert.match(html,/text or email required \(Twilio\)/);
    assert.doesNotMatch(html,/not required by the saved policy/);
  }
  assert.match(render({config:{requirePhoneVerification:true,smsConfirmations:false},integrations:{verification:{enabled:false,configured:true}}}),/Twilio verification is not ready/);
});
