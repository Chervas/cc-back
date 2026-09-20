'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { appointmentImportReview } = require('../../lib/appointment-import-review');
test('import summary exposes no source content and removes resolved assignments', () => {
  const row = { source_system: 'cliniccloud', doctor_id: 53, instalacion_id: null, tratamiento_id: 7,
    import_metadata: { source_contact_id: 'private', raw: 'private', cliniccloud_delta: { pending_assignment: ['doctor_id','installation_id','treatment_id','untrusted'] } } };
  assert.deepEqual(appointmentImportReview(row), { source: 'cliniccloud', reminders_held: true, pending_assignment: ['installation'] });
  row.instalacion_id = 13;
  assert.deepEqual(appointmentImportReview(row).pending_assignment, []);
});
test('native visits never acquire import warnings and malformed metadata fails closed without raw disclosure', () => {
  assert.equal(appointmentImportReview({}), null);
  assert.deepEqual(appointmentImportReview({ source_system: 'cliniccloud', import_metadata: '{broken' }), { source: 'cliniccloud', reminders_held: true, pending_assignment: [] });
});
