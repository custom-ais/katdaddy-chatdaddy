import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/customer/BookingBot.tsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function VerifyPhone('), source.indexOf('\nfunction SlotPicker('));

test('verification UI only accepts explicit numeric four-digit metadata; legacy defaults to six', () => {
  const expression = component.match(/const codeLength = ([^;]+);/)[1];
  const lengthFor = new Function('info', `return ${expression};`);
  assert.equal(lengthFor({ codeLength: 4 }), 4);
  for (const info of [undefined, {}, { codeLength: 6 }, { codeLength: '4' }, { codeLength: 0 }, { codeLength: 8 }]) assert.equal(lengthFor(info), 6);
});
test('copy, paste limits, field length, submit guard, and placeholder share the server-selected length', () => {
  for (const expected of ['${codeLength}-digit code', 'maxLength={codeLength}', '.slice(0, codeLength)', "placeholder={'•'.repeat(codeLength)}", "code.replace(/\\D/g, '').length !== codeLength", 'code.length !== codeLength']) assert.ok(component.includes(expected), expected);
  assert.doesNotMatch(component, /6-digit|maxLength=\{6\}|slice\(0, 6\)|length !== 6/);
});
test('restored verification prefers public server status and preserves explicit four-digit metadata', () => {
  assert.ok(source.includes('setVerification(r.verification || { codeLength: r.config?.verificationCodeLength === 4 ? 4 : 6,'));
});
