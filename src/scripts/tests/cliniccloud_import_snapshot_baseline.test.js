'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalImportedBaseline } = require('../cliniccloud-import-snapshot');
const fields = { name: 'PERSONA', surname: 'FICTICIA', email: 'qa@example.invalid', phone: '600900001', national_id: '', birth_date: '1990-01-01' };
function row(patch = {}) { return { source_column: 'cliniccloud_contact_snapshot', source_contact_id: '123', history_number: '456', canonical_snapshot: JSON.stringify({ version: 'cliniccloud_contact_snapshot/1', source_account: 'cliniccloud-5880', contact: { idContacto: '123', num: '456' }, fields, ...patch }) }; }
test('canonical baseline keeps exactly six source fields and recognizes identity/NUM', () => assert.deepEqual(canonicalImportedBaseline([row({ fields: { ...fields, WHATSAPP: 'ignored' } })]), fields));
test('legacy source supplies no fabricated baseline', () => assert.equal(canonicalImportedBaseline([{ source_column: 'contacto_1.csv' }]), null));
test('stored baseline is separate from source casing and phone representation', () => {
  const stored = { ...fields, name: 'Persona', surname: 'Ficticia', phone: '600900002' };
  assert.deepEqual(canonicalImportedBaseline([row({ stored_fields: stored })], 'stored_fields'), stored);
  assert.deepEqual(canonicalImportedBaseline([row({ stored_fields: stored })]), fields);
  assert.throws(() => canonicalImportedBaseline([row()], 'stored_fields'), /BASELINE_INVALID/);
});
test('canonical baseline rejects other account/version/identity', () => {
  for (const patch of [{ source_account: 'other' }, { version: 'other' }, { contact: { idContacto: '9', num: '456' } }]) assert.throws(() => canonicalImportedBaseline([row(patch)]), /CANONICAL_CONTACT_SNAPSHOT_INVALID/);
});
test('canonical baseline rejects divergent copies and invalid birth dates', () => {
  assert.throws(() => canonicalImportedBaseline([row(), row({ fields: { ...fields, name: 'OTRO' } })]), /AMBIGUOUS/);
  assert.throws(() => canonicalImportedBaseline([row({ fields: { ...fields, birth_date: '1990-02-31' } })]), /BASELINE_INVALID/);
  assert.deepEqual(canonicalImportedBaseline([row(), row()]), fields);
});
