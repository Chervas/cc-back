'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectCatalogSourceCandidates: select } = require('../../lib/automation-catalog-source-selection');

test('inactive mobile verification master can be distributed without enabling a system execution', () => {
  const master = { id: 1, is_active: false, is_system: true, clinic_id: null, group_id: null,
    trigger_type: 'patient.mobile_verification_requested' };
  assert.deepEqual(select([master]), [master]);
  assert.deepEqual(select([{ ...master, is_system: 1 }]), [{ ...master, is_system: 1 }]);
  for (const patch of [{ clinic_id: 72 }, { group_id: 5 }, { is_system: false }, { trigger_type: 'appointment_created' }]) {
    assert.deepEqual(select([{ ...master, ...patch }]), []);
  }
});

test('existing active source and managed-lead/review fallback policies stay unchanged', () => {
  const active = { id: 2, is_active: true, trigger_type: 'appointment_created' };
  const inactive = { id: 3, is_active: false, trigger_config: { managed_feature: 'lead_auto_reply' } };
  assert.deepEqual(select([active, inactive]), [active]);
  assert.deepEqual(select([inactive]), [inactive]);
  const review = { is_active: false, nodes: [{ type: 'action/request_review' }] };
  assert.deepEqual(select([review]), [review]);
});
