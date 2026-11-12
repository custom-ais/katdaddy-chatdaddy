import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as activityText from '../shared/activity-text.mjs';

const { describeActivity } = activityText;
const require = createRequire(import.meta.url);
const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const fallbackTitle = (kind) => kind.replace(/[._]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const CODE = /\b[a-z]+(?:_[a-z]+)*\.[a-z_]+\b/; // e.g. "request.finished", "customer_sms.failed_or_uncertain"

test('every activity kind the server records has plain-English wording', async () => {
  const server = (await Promise.all(['app.mjs', 'email-notification.mjs', 'owner-notification.mjs', 'owner-error-notification.mjs', 'sms-notification.mjs'].map((f) => source(`server/${f}`)))).join('\n');
  const fixed = new Set([...server.matchAll(/(?:record\(req,\s*|\.log\(\s*)["']([a-z_]+\.[a-z_.]+)["']/g)].map((m) => m[1]));
  // Kinds the customer widget may send (server/app.mjs only accepts these).
  for (const kind of ['widget.minimized', 'widget.expanded', 'widget.nudge_opened', 'client.error']) fixed.add(kind);
  // Kinds built from a send result's status.
  for (const family of [...server.matchAll(/\.log\(\s*`([a-z_]+)\.\$\{result\.status\}`/g)].map((m) => m[1])) {
    for (const status of ['accepted', 'skipped', 'already_attempted', 'rejected', 'failed', 'failed_or_uncertain']) fixed.add(`${family}.${status}`);
  }
  assert.ok(fixed.size >= 30, `found the server's activity kinds (${fixed.size})`);
  for (const kind of fixed) {
    const text = describeActivity({ kind, details: {} });
    assert.notEqual(text.title, fallbackTitle(kind), `${kind} has its own wording`);
    assert.doesNotMatch(text.title, CODE, `${kind} title has no internal code`);
  }
});

test('every change a customer or the office makes is named, not just "used BOB"', async () => {
  const app = await source('server/app.mjs');
  const routes = [...app.matchAll(/method === ["']([A-Z]+)["'] && pathname === ["'](\/api\/[^"']+)["']/g)].map((m) => [m[1], m[2]])
    .filter(([method, path]) => path !== '/api/health' && (method !== 'GET' || !path.startsWith('/api/admin/'))); // health checks are never recorded
  assert.ok(routes.length >= 30, 'found the routes');
  for (const [method, path] of routes) {
    const { title } = describeActivity({ kind: 'request.finished', details: { method, path, status: 200 } });
    assert.doesNotMatch(title, /used (BOB|the dashboard)$/, `${method} ${path}: ${title}`);
    assert.doesNotMatch(title, /\/api\//, 'no web address in the title');
  }
});

test('behind-the-scenes requests read as plain sentences and say what went wrong', () => {
  const ok = describeActivity({ kind: 'request.finished', level: 'info', details: { method: 'POST', path: '/api/holds', status: 200, timing: { ms: 2345 } } });
  assert.deepEqual([ok.title, ok.detail, ok.tone, ok.routine], ['A customer held an appointment time', 'Took 2.3 seconds.', 'info', true]);

  const taken = describeActivity({ kind: 'request.finished', level: 'warning', details: { method: 'POST', path: '/api/holds', status: 409, error: 'That time was just taken.' } });
  assert.equal(taken.title, "A customer couldn't hold an appointment time");
  assert.match(taken.detail, /BOB told them: "That time was just taken\."/);
  assert.equal(taken.tone, 'attention');
  assert.equal(taken.routine, false, 'never hidden');

  const broke = describeActivity({ kind: 'request.finished', level: 'error', details: { method: 'POST', path: '/api/bookings', status: 500 } });
  assert.match(broke.title, /^Something went wrong on BOB's side when a customer tried to confirm their booking$/);
  assert.match(broke.detail, /wasn't their fault/);
  assert.equal(broke.tone, 'problem');

  const office = describeActivity({ kind: 'request.finished', level: 'warning', details: { method: 'PATCH', path: '/api/admin/config', status: 403 } });
  assert.equal(office.title, "A team member couldn't save settings");
  assert.match(office.detail, /permission/);
});

test('texts and emails say whether they went out, without overstating delivery', () => {
  const sent = describeActivity({ kind: 'email_notification.accepted', level: 'info', details: { kind: 'appointment_confirmed', status: 'accepted' } });
  assert.equal(sent.title, 'Sent the booking confirmation email to the customer');
  assert.match(sent.detail, /doesn't prove it reached the inbox/);
  assert.equal(sent.tone, 'good');

  const unsure = describeActivity({ kind: 'customer_sms.failed_or_uncertain', level: 'warning', details: {} });
  assert.equal(unsure.title, 'The booking confirmation text to the customer may not have been sent');
  assert.match(unsure.detail, /follow up by phone/);

  const capped = describeActivity({ kind: 'owner_error_alert.skipped', details: { kind: 'jobber', reason: 'daily_cap' } });
  assert.equal(capped.title, "Didn't send the owner's alert text about a problem with the Jobber connection");
  assert.match(capped.detail, /limit of 10/);

  const failed = describeActivity({ kind: 'notification.failed', level: 'error', details: { approvalId: 'A1', channel: 'sms', recipient: 'Pat', error: 'Invalid number' } });
  assert.equal(failed.title, "Couldn't send the text to Pat about a customer's request");
  assert.match(failed.detail, /"Invalid number"/);
  assert.equal(failed.tone, 'problem');
});

test('conversations show who said what, and codes stay hidden', () => {
  const said = describeActivity({ kind: 'conversation.message', details: { role: 'user', text: 'Do you clean chimneys?', stage: 'offer' } });
  assert.deepEqual([said.title, said.quote, said.detail, said.chat], ['Customer wrote', { who: 'customer', text: 'Do you clean chimneys?' }, 'While choosing a service.', true]);
  const code = describeActivity({ kind: 'conversation.message', details: { role: 'user', text: '[verification code omitted]' } });
  assert.match(code.quote.text, /Hidden for security/);
  const reply = describeActivity({ kind: 'conversation.message', details: { role: 'assistant', text: 'Yes!', via: 'ai' } });
  assert.equal(reply.title, 'BOB replied');
  assert.match(reply.detail, /AI assistant/);
  const unanswered = describeActivity({ kind: 'conversation.unanswered_question', level: 'warning', details: { text: 'Chimneys?' } });
  assert.match(unanswered.detail, /Settings → Answers/);
  assert.equal(unanswered.tone, 'attention');
});

test('the saved level decides how serious an entry looks, and odd records never break the page', () => {
  assert.equal(describeActivity({ kind: 'conversation.started', level: 'error', details: {} }).tone, 'problem');
  assert.equal(describeActivity({ kind: 'conversation.started', level: 'warning', details: {} }).tone, 'attention');
  for (const odd of [null, undefined, {}, { kind: 'brand.new_kind' }, { kind: 'request.finished', details: 'oops' }, { kind: 'coverage.checked', details: { miles: null, minutes: null } }]) {
    const text = describeActivity(odd);
    assert.equal(typeof text.title, 'string');
    assert.ok(text.title.length > 0);
  }
  assert.equal(describeActivity({ kind: 'brand.new_kind' }).title, 'Brand new kind');
});

async function loadPage() {
  const code = ts.transpileModule(await source('src/admin/ActivityLogPage.tsx'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const ui = { ErrorNote: ({ children }) => React.createElement('p', null, children), Field: ({ label, children }) => React.createElement('label', null, label, children), inputClass: '', secondaryButton: '' };
  const deps = { '../lib/api': { api: async () => ({}), saveText: () => {} }, '../../shared/activity-text.mjs': activityText, './ui': ui };
  const out = {};
  new Function('require', 'exports', code)((id) => deps[id] || require(id), out);
  return out;
}

test('the Activity page shows the plain sentence and keeps the raw record under technical details', async () => {
  const { ActivityEntry, dayHeading } = await loadPage();
  const item = { id: 'EV1', kind: 'request.finished', created: Date.UTC(2026, 10, 12, 20, 5), level: 'error', sessionId: 'abc123', requestId: 'RQ1', details: { method: 'POST', path: '/api/bookings', status: 500 } };
  const html = renderToStaticMarkup(React.createElement(ActivityEntry, { item, showConversation: true, onShowConversation: () => {} }));
  assert.match(html, /Problem/);
  assert.match(html, /Something went wrong on BOB(&#x27;|')s side when a customer tried to confirm their booking/);
  assert.match(html, /See this whole conversation/);
  assert.match(html, /1:05 PM/, 'Arizona time');
  const [visible, technical] = html.split('Technical details (for support)');
  assert.ok(technical, 'raw details are still available');
  assert.doesNotMatch(visible, /request\.finished|\/api\/bookings/, 'no codes before the technical details');
  assert.match(technical, /request\.finished/);

  const chat = renderToStaticMarkup(React.createElement(ActivityEntry, { item: { id: 'EV2', kind: 'conversation.message', created: Date.UTC(2026, 10, 12, 20, 5), level: 'info', details: { role: 'user', text: 'Hi there' } } }));
  assert.match(chat, /<blockquote[^>]*><span class="font-bold">Customer: <\/span>Hi there<\/blockquote>/);

  const now = Date.UTC(2026, 10, 12, 20, 0);
  assert.equal(dayHeading(now - 3_600_000, now), 'Today');
  assert.equal(dayHeading(now - 86_400_000, now), 'Yesterday');
  assert.equal(dayHeading(Date.UTC(2026, 10, 9, 20), now), 'Monday, November 9');
  assert.equal(dayHeading(Date.UTC(2025, 11, 31, 20), now), 'Wednesday, December 31, 2025');
});
