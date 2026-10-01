'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { selectEffectiveAppointmentTemplates, belongsToAppointmentScope } = require('../../lib/appointment-template-scope');
const base = { id: 1, template_key: 'system_cancel_unconfirmed', version: 7,
  clinic_id: null, group_id: null, is_system: true, is_active: true,
  published_at: new Date('2026-09-06T23:04:34Z') };

test('a clinic instance is never a group-wide automation', () => {
  const hospitalet = { ...base, id: 2, template_key: 'system_cancel_unconfirmed__clinic_59', clinic_id: 59, group_id: 5, is_system: false };
  assert.equal(belongsToAppointmentScope(hospitalet, 35, 5), false);
  assert.equal(belongsToAppointmentScope(hospitalet, 59, 5), true);
  assert.deepEqual(selectEffectiveAppointmentTemplates([hospitalet], 35, 5), []);
});

test('an inactive clinic instance suppresses the active master but not a customized duplicate', () => {
  const local = { ...base, id: 3, template_key: 'system_cancel_unconfirmed__clinic_35', clinic_id: 35, group_id: 5, is_system: false, is_active: false };
  const custom = { ...local, id: 4, template_key: 'cancel_personalizado', is_active: true };
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, local, custom], 35, 5).map(r => r.id), [4]);
});

test('an older active version cannot bypass a newer disabled published version', () => {
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, { ...base, id: 5, version: 8, is_active: false }], 35, 5), []);
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, { ...base, id: 6, version: 8, is_active: false, published_at: null }], 35, 5), [base]);
});

test('real group automations stay available only in their group; clinic scope wins', () => {
  const group = { ...base, id: 7, group_id: 5, is_system: false };
  const local = { ...base, id: 8, template_key: 'system_cancel_unconfirmed__clinic_35', clinic_id: 35, group_id: 5, is_system: false };
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, group], 36, 5), [group]);
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, group, local], 35, 5), [local]);
  assert.deepEqual(selectEffectiveAppointmentTemplates([group], 36, 6), []);
});

test('a newer master version cannot erase a disabled scoped instance using the same key', () => {
  const group = { ...base, id: 9, version: 1, group_id: 5, is_system: false, is_active: false };
  const local = { ...group, id: 10, clinic_id: 35, is_active: true };
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, group], 35, 5), []);
  assert.deepEqual(selectEffectiveAppointmentTemplates([base, group, local], 35, 5), [local]);
});
