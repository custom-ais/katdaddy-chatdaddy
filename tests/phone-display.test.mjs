import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsPhone, phoneEdit } from '../shared/phone-display.mjs';
import { normalizePhone } from '../shared/domain.mjs';

test('US display formats partial typing and complete ten digit numbers', () => {
  for (const [raw, expected] of [['',''],['6','(6'],['62','(62'],['623','(623)'],['6235','(623) 5'],['623555','(623) 555'],['6235551','(623) 555-1'],['6235551234','(623) 555-1234']]) assert.equal(formatUsPhone(raw), expected);
});
test('US +1 paste and existing formatted values preserve normalized verification binding', () => {
  const canonical = '+16235551234';
  for (const value of [canonical, '+1 (623) 555-1234', '16235551234', '(623) 555-1234', '623-555-1234']) {
    const display = formatUsPhone(value);
    assert.equal(display, '(623) 555-1234');
    assert.equal(normalizePhone(display), canonical);
    assert.equal(normalizePhone(display), normalizePhone(value));
    assert.equal(formatUsPhone(display), display);
  }
});
test('unsupported international, excessive digits, and prose are not truncated or reinterpreted', () => {
  for (const value of ['+442079460123', '+33 1 23 45 67 89', '623555123456', '+162355512345', 'call 6235551234', '6235551234 ext 9']) assert.equal(formatUsPhone(value), value);
  assert.equal(normalizePhone(formatUsPhone('623555123456')), null);
  assert.equal(normalizePhone(formatUsPhone('+442079460123')), null);
});
test('caret follows digit across inserted punctuation and country code paste', () => {
  assert.deepEqual(phoneEdit('(623) 555', '(623) 5551', 10, 10, 'insertText'), {value:'(623) 555-1',start:11,end:11});
  assert.deepEqual(phoneEdit('', '+16235551234', 12, 12, 'insertFromPaste'), {value:'(623) 555-1234',start:14,end:14});
  const edit = phoneEdit('(623) 555-1234', '(623) 955-1234', 7, 7, 'insertText');
  assert.deepEqual(edit, {value:'(623) 955-1234',start:7,end:7});
});
test('backspace/delete over formatting does not trap the caret', () => {
  assert.deepEqual(phoneEdit('(623)', '(623', 4, 4, 'deleteContentBackward'), {value:'(62',start:3,end:3});
  assert.deepEqual(phoneEdit('(623) 555-1234', '(623) 5551234', 9, 9, 'deleteContentBackward'), {value:'(623) 551-234',start:8,end:8});
  assert.deepEqual(phoneEdit('(623) 555-1234', '(623) 5551234', 9, 9, 'deleteContentForward'), {value:'(623) 555-234',start:9,end:9});
});
test('range replacement and selection offsets retain digits rather than jump to end', () => {
  assert.deepEqual(phoneEdit('(623) 555-1234', '(623) 7-1234', 7, 7, 'insertText'), {value:'(623) 712-34',start:7,end:7});
  const selected = phoneEdit('', '6235551234', 3, 6, 'insertFromPaste');
  assert.deepEqual(selected, {value:'(623) 555-1234',start:4,end:9});
  assert.deepEqual(phoneEdit('(623)', '', 0, 0, 'deleteContentBackward'), {value:'',start:0,end:0});
});
