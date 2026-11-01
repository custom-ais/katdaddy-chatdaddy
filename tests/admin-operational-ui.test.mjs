import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as domain from '../shared/domain.mjs';
import * as catalog from '../shared/catalog.mjs';

const require = createRequire(import.meta.url);
const compile = text => ts.transpileModule(text, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const appointment = {
  id: 'AP-TEST', customerName: 'Synthetic Customer', email: '', phone: '+16235550100', address: '100 Test St', city: 'Test City', zip: '85326', package: 'Synthetic cleaning', status: 'confirmed', scheduledAt: '2026-11-02T17:00:00Z', durationMins: 60, technicianId: 'TECH-1', technicianName: 'Synthetic Technician', urgency: 'normal', source: 'phone_dispatch', createdAt: '2026-11-01T17:00:00Z', revision: 1,
};
const tech = { id: 'TECH-1', name: 'Synthetic Technician', status: 'available', color: '#123456', zone: 'Test zone', phone: '', jobberUserId: '' };
const ui = {
  Modal: ({ title, footer, children }) => React.createElement('section', null, React.createElement('h2', null, title), children, footer),
  Field: ({ label, children }) => React.createElement('label', null, label, children),
  Banner: ({ title, children }) => React.createElement('section', null, title, children),
  ErrorNote: ({ children }) => React.createElement('p', { role: 'alert' }, children),
  StatusBadge: () => null,
  Toggle: ({ label, checked, disabled }) => React.createElement('label', null, React.createElement('input', { type: 'checkbox', checked, disabled, readOnly: true }), label),
};
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of [...React.Children.toArray(node.props?.children), ...React.Children.toArray(node.props?.footer)]) {
    const found = find(child, predicate); if (found) return found;
  }
  return null;
}
async function harness(file, permissions = [], extraData = {}) {
  const granted = new Set(permissions), calls = [], states = []; let cursor = 0;
  const react = { ...React, useState: init => { const i = cursor++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; }, useMemo: fn => fn(), useEffect: () => {} };
  const data = { config: structuredClone(domain.DEFAULT_CONFIG), access: { role: 'member', name: 'Synthetic Staff' }, appointments: [appointment], technicians: [tech], approvals: [], requests: [], integrations: {}, ...extraData };
  const context = { data, can: key => granted.has(key), activeAppointments: data.appointments, mutate: async (path, body, method) => { calls.push({ path, body, method }); return {}; }, showToast: () => {} };
  const dashboard = { useDashboard: () => context, azDate: iso => new Date(iso).toISOString().slice(0, 10), azDay: () => 'Nov 2', azTime: () => '10 AM', dollars: value => `$${Number(value).toFixed(2)}`, initials: () => 'ST', attentionReason: a => a.status === 'action_needed' ? 'Appointment needs review' : null, isLinked: () => false };
  const deps = { react, './DashboardContext': dashboard, './ui': ui, '../../shared/domain.mjs': domain, '../../shared/catalog.mjs': catalog, '../components/PhoneInput': { PhoneInput: ({ onValueChange, ...props }) => React.createElement('input', { ...props, readOnly: true }) }, './AppointmentDetailModal': { AppointmentDetailModal: () => null }, './TechnicianManagement': { TechnicianManagement: () => null } };
  const out = {}; new Function('require', 'exports', compile(await readFile(new URL(`../src/admin/${file}.tsx`, import.meta.url), 'utf8')))(id => deps[id] || require(id), out);
  return { calls, granted, render: props => { cursor = 0; return out[file](props || {}); }, find, button: (tree, label) => find(tree, n => n.type === 'button' && n.props.children === label) };
}

test('appointment viewers can inspect records without edit/send controls or missing financial values rendering as NaN', async () => {
  const h = await harness('AppointmentDetailModal', ['appointments.view']);
  const tree = h.render({ appointment, onClose() {} }), html = renderToStaticMarkup(tree);
  assert.match(html, /view-only access/); assert.match(html, /Restricted/);
  assert.doesNotMatch(html, /Save changes|Send manual confirmation|\$NaN/);
  assert.equal(h.find(tree, n => n.type === 'select').props.disabled, true);
  assert.equal(h.calls.length, 0);
});

test('nonfinancial appointment editing preserves redacted stored notes', async () => {
  const h = await harness('AppointmentDetailModal', ['appointments.view', 'appointments.manage']);
  const tree = h.render({ appointment, onClose() {} });
  await h.button(tree, 'Save changes').props.onClick();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'PATCH');
  assert.equal(Object.hasOwn(h.calls[0].body, 'notes'), false);
  assert.equal(h.calls[0].body.revision, 1);
});

test('appointment handlers recheck changed permissions before mutation', async () => {
  const h = await harness('AppointmentDetailModal', ['appointments.view', 'appointments.manage']);
  const tree = h.render({ appointment, onClose() {} });
  h.granted.delete('appointments.manage');
  await h.button(tree, 'Save changes').props.onClick();
  assert.equal(h.calls.length, 0);
});

test('appointment list and technician board hide financial amounts while preserving read-only navigation', async () => {
  for (const name of ['AppointmentManager', 'TechnicianManagement']) {
    const h = await harness(name, ['appointments.view']);
    const html = renderToStaticMarkup(h.render({ onOpen() {} }));
    assert.match(html, /Restricted/); assert.doesNotMatch(html, /\$NaN/);
    if (name === 'AppointmentManager') assert.doesNotMatch(html, /aria-label="Mark in progress"/);
    else assert.match(html, /aria-label="Synthetic Technician status"[^>]*disabled/);
  }
});

test('inbox viewers see approval detail but cannot approve or decline and see no financial totals', async () => {
  const approval = { id: 'APR-1', customer: { name: 'Synthetic Customer', phone: '+16235550100', address: '100 Test St', city: 'Test City', zip: '85326' }, service: 'Synthetic service', status: 'pending', requestedAt: Date.parse('2026-11-01T17:00:00Z'), scheduledAt: appointment.scheduledAt, expiresAt: Date.now() + 600_000, durationMins: 60, technicianName: tech.name };
  const h = await harness('InboxPage', ['inbox.view'], { approvals: [approval] });
  const html = renderToStaticMarkup(h.render({ focusApproval: 'APR-1' }));
  assert.match(html, /view-only access to the inbox/); assert.match(html, /Restricted/);
  assert.doesNotMatch(html, /Approve and book|>Decline<|\$NaN/); assert.equal(h.calls.length, 0);
});

test('office booking is unavailable to viewers and never requests confirmation without its action permission', async () => {
  const viewer = await harness('NewAppointmentModal', ['appointments.view']);
  assert.match(renderToStaticMarkup(viewer.render({ onClose() {} })), /do not have permission to create/);
  const h = await harness('NewAppointmentModal', ['appointments.view', 'appointments.manage']);
  const tree = h.render({ onClose() {} });
  assert.doesNotMatch(renderToStaticMarkup(tree), /\$NaN/);
  await h.find(tree, n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].body.sendConfirmation, false);
  h.granted.delete('appointments.manage');
  await h.find(tree, n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls.length, 1);
});

test('approval and resolution explain automatic notifications even without manual sending permission', async () => {
  const approval = { id: 'APR-1', customer: { name: 'Synthetic Customer' }, service: 'Synthetic service', status: 'pending', requestedAt: Date.parse('2026-11-01T17:00:00Z'), scheduledAt: appointment.scheduledAt, expiresAt: Date.now() + 600_000 };
  const inbox = await harness('InboxPage', ['inbox.view', 'inbox.manage'], { approvals: [approval] });
  const inboxHtml = renderToStaticMarkup(inbox.render({ focusApproval: 'APR-1' }));
  const detail = await harness('AppointmentDetailModal', ['appointments.view', 'appointments.manage']);
  const detailHtml = renderToStaticMarkup(detail.render({ appointment: { ...appointment, status: 'action_needed', jobberState: 'uncertain' }, onClose() {} }));
  assert.match(inboxHtml, /Approve and book/); assert.match(detailHtml, /confirm it/);
  for (const html of [inboxHtml, detailHtml]) {
    assert.match(html, /may send configured automatic customer and owner notifications/);
    assert.match(html, /Existing consent and sending holds still apply/);
    assert.doesNotMatch(html, /Send manual confirmation/);
  }
  assert.equal(inbox.calls.length + detail.calls.length, 0);
});

test('explicit confirmation action is labeled manual and still needs its own permission', async () => {
  const h = await harness('AppointmentDetailModal', ['appointments.view', 'appointments.send'], { integrations: { sms: { enabled: true, configured: true } } });
  assert.match(renderToStaticMarkup(h.render({ appointment, onClose() {} })), /Send manual confirmation/);
  h.granted.delete('appointments.send');
  assert.doesNotMatch(renderToStaticMarkup(h.render({ appointment, onClose() {} })), /Send manual confirmation/);
});
