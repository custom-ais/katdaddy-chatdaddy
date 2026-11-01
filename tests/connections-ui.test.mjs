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
  assert.match(source, /i\.leadConnector\?\.health\?\.status === 'healthy'/);
  assert.match(source, /i\.maps\?\.health\?\.status === 'healthy'/);
  assert.match(source, /onClick=\{\(\) => void refresh\(\)\}/);
  assert.match(source, /does not run external provider checks/);
  assert.match(source, /Configuration warning \(not a confirmed authentication failure\)/);
});

const accountSource = source.slice(source.indexOf('function AccountIdentity('), source.indexOf('\nfunction Connections()'));
const accountCode = ts.transpileModule(`${when}\nexport ${accountSource}`, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const accountExports = {};
new Function('require', 'exports', accountCode)(require, accountExports);
test('account identity requires explicit verified name; opaque config never infers identity', () => {
  const renderAccount = account => renderToStaticMarkup(React.createElement(accountExports.AccountIdentity, {account}));
  for (const account of [undefined, {}, {status:'unverified',displayName:'Do not claim'}, {status:'unavailable'}, {status:'verified'}]) assert.match(renderAccount(account), /Account identity not verified/);
  assert.match(renderAccount({status:'verified',displayName:'Example Company',checkedAt:1000}), /Verified account.*Example Company/);
});
test('account names refresh is explicit and separate from passive status refresh', () => {
  assert.ok(source.includes("api('/api/admin/integration-accounts', { method: 'POST', body: {} })"));
  assert.match(source, /onClick=\{\(\) => void refreshAccounts\(\)\}/);
  assert.match(source, /i\.accounts\?\.jobber/);
  assert.match(source, /Google and Gemini account identity is not verified/);
});
