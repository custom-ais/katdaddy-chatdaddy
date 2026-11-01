import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../shared/domain.mjs';
test('US display formatting preserves canonical E164 destinations',()=>{
 for(const input of ['6235550123','(623) 555-0123','+1 (623) 555-0123','1-623-555-0123'])assert.equal(normalizePhone(input),'+16235550123');
});
test('unsupported international, alphabetic, incomplete, or extended phones cannot become a different US recipient',()=>{
 for(const input of ['+44 12345678','+44 2071234567','abc6235550123','6235550123 ext 2','623555012','623555012345','+6235550123'])assert.equal(normalizePhone(input),null,input);
});
