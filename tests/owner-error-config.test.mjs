import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig, withConfigDefaults } from '../shared/domain.mjs';
import { CONFIG_FIELD_PERMISSIONS, PERMISSION_KEYS } from '../shared/admin-permissions.mjs';
import { applyConfigPatch, projectConfig, projectSnapshot } from '../server/admin-authorization.mjs';

const master = { id:'owner', role:'master', permissions:[] };
const member = (...permissions) => ({ id:'staff', role:'member', permissions });
const config = overrides => withConfigDefaults({ ...structuredClone(DEFAULT_CONFIG), ...overrides });
const denied = fn => assert.throws(fn, { status:403, code:'PERMISSION_DENIED' });

test('error alerts default off for new and existing booking-alert settings', () => {
  assert.equal(DEFAULT_CONFIG.ownerErrorSmsEnabled, false);
  assert.equal(withConfigDefaults({}).ownerErrorSmsEnabled, false);
  const old = { bookingOwnerSmsEnabled:true, bookingOwnerSmsPhone:'+16235550100' };
  assert.equal(withConfigDefaults(old).ownerErrorSmsEnabled, false);
  assert.equal(withConfigDefaults(old).bookingOwnerSmsEnabled, true);
  assert.equal(Object.hasOwn(old,'ownerErrorSmsEnabled'), false);
  assert.equal(withConfigDefaults({ ownerErrorSmsEnabled:true }).ownerErrorSmsEnabled, true);
});

test('each owner alert switch independently requires the same valid recipient', () => {
  assert.deepEqual(validateConfig(config()), []);
  for (const enabled of [
    { ownerErrorSmsEnabled:true },
    { bookingOwnerSmsEnabled:true },
    { ownerErrorSmsEnabled:true, bookingOwnerSmsEnabled:true },
  ]) {
    for (const phone of ['', 'invalid', '+16235550100 ext 2']) {
      assert.ok(validateConfig(config({ ...enabled, bookingOwnerSmsPhone:phone })).some(error => /owner notification/.test(error)));
    }
    assert.deepEqual(validateConfig(config({ ...enabled, bookingOwnerSmsPhone:'+16235550100' })), []);
  }
  assert.equal(validateConfig(config({ ownerErrorSmsEnabled:true, bookingOwnerSmsPhone:'+16235550100' })).length, 0);
});

test('error alert switch requires a boolean, without treating strings as enabled settings', () => {
  for (const value of ['true', 'false', 1, 0, null, undefined]) {
    assert.ok(validateConfig(config({ ownerErrorSmsEnabled:value, bookingOwnerSmsPhone:'+16235550100' })).includes('Invalid ownerErrorSmsEnabled.'));
  }
});

test('only master can supply the error-alert field, including unchanged values and forged grants', () => {
  assert.equal(CONFIG_FIELD_PERMISSIONS.ownerErrorSmsEnabled, 'ownerSms.manage');
  const old = config({ bookingOwnerSmsPhone:'+16235550100' });
  const before = structuredClone(old);
  for (const principal of [member(), member('settings.booking.view','settings.booking.manage'), member(...PERMISSION_KEYS)]) {
    for (const value of [false, true]) denied(() => applyConfigPatch(principal, { ownerErrorSmsEnabled:value }, old));
  }
  const staff = member('settings.business.view','settings.business.manage');
  denied(() => applyConfigPatch(staff, { businessName:'Uncommitted change', ownerErrorSmsEnabled:true }, old));
  assert.deepEqual(old,before);
  const next = applyConfigPatch(master, { ownerErrorSmsEnabled:true }, old);
  assert.equal(next.ownerErrorSmsEnabled,true);
  assert.equal(next.bookingOwnerSmsEnabled,false);
  assert.equal(next.bookingOwnerSmsPhone,old.bookingOwnerSmsPhone);
  assert.deepEqual(validateConfig(next),[]);
  assert.deepEqual(old,before);
  denied(() => applyConfigPatch(master, { futureOwnerErrorControl:true }, old));
});

test('member snapshots redact the error-alert setting and recipient even with forged owner permissions', () => {
  const old = config({ ownerErrorSmsEnabled:true, bookingOwnerSmsEnabled:true, bookingOwnerSmsPhone:'+16235550100' });
  const before = structuredClone(old);
  for (const principal of [member(), member('settings.booking.view','settings.connections.view','finance.view'), member(...PERMISSION_KEYS)]) {
    for (const projected of [projectConfig(old,principal), projectSnapshot({ config:old },principal).config]) {
      assert.equal(projected.ownerErrorSmsEnabled,false);
      assert.equal(projected.bookingOwnerSmsEnabled,false);
      assert.equal(projected.bookingOwnerSmsPhone,'');
    }
  }
  for (const projected of [projectConfig(old,master), projectSnapshot({ config:old },master).config]) {
    assert.equal(projected.ownerErrorSmsEnabled,true);
    assert.equal(projected.bookingOwnerSmsPhone,'+16235550100');
  }
  assert.deepEqual(old,before);
});
