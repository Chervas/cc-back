'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { candidates, fieldsOf, sourceIds, validPatch, validateCurrent, packageHash, validatePackage, VERSION } = require('../../lib/cliniccloud-import/contacts-apply');
const before = { id_paciente: 1, clinica_id: 72, nombre: 'Ejemplo', apellidos: 'Prueba', email: '', telefono_movil: '', dni: '', fecha_nacimiento: null };
const links = [{ source: 'cliniccloud', source_column: 'idContacto', value: '42' }];
function fixture() {
  const snapshot = { source_account: 'cliniccloud-5880', complete_for: { clinic_ids: [72, 66] }, patients: [{ id: 1, clinic_id: 72, source_contact_ids: ['42'], fields: fieldsOf(before) }] };
  const actions = [{ entity: 'patient', action: 'link_patient', local_id: 1, source_contact_id: '42', action_key: 'test', fields_patch: { email: 'test@example.invalid' }, requires_review: false, reasons: [] }];
  const manifest = { source_account: 'cliniccloud-5880', snapshot_sha256: hash(snapshot), automation_policy: 'hold', physical_deletes: false, whatsapp_column_policy: 'ignored_no_consent_mutation' };
  return { snapshot, plan: { manifest, actions, plan_sha256: hash({ manifest, actions }) } };
}
test('only exact linked nonempty safe contact patches are selected', () => { const { plan, snapshot } = fixture(); assert.equal(candidates(plan, snapshot).length, 1); });
test('WhatsApp, clinic, clinical and empty fields cannot enter the SQL allowlist', () => { for (const patch of [{ whatsapp: 'yes' }, { clinica_id: '66' }, { antecedentes: 'x' }, { name: '' }, { name: 'x\n' }, { birth_date: '2026-02-30' }]) assert.equal(validPatch(patch), false); });
test('tampered manifest or snapshot is rejected', () => { const { plan, snapshot } = fixture(); plan.manifest.automation_policy = 'normal'; assert.throws(() => candidates(plan, snapshot), /PLAN_HASH/); });
test('review flags and duplicate patient actions fail closed', () => { const { plan, snapshot } = fixture(); plan.actions[0].requires_review = true; plan.plan_sha256 = hash({ manifest: plan.manifest, actions: plan.actions }); assert.throws(() => candidates(plan, snapshot), /UNREVIEWED/); plan.actions[0].requires_review = false; plan.actions.push({ ...plan.actions[0] }); plan.plan_sha256 = hash({ manifest: plan.manifest, actions: plan.actions }); assert.throws(() => candidates(plan, snapshot), /MULTIPLE_PATCHES/); });
test('live clinic, fields and identity drift stop a correction', () => { const { plan, snapshot } = fixture(); const op = candidates(plan, snapshot)[0]; validateCurrent(op, before, links); assert.throws(() => validateCurrent(op, { ...before, clinica_id: 66 }, links), /CLINIC_DRIFT/); assert.throws(() => validateCurrent(op, { ...before, email: 'local@example.invalid' }, links), /FIELDS_DRIFT/); assert.throws(() => validateCurrent(op, before, []), /IDENTITY_DRIFT/); });
test('raw historical contact is identity evidence, other custom data is not', () => { assert.deepEqual(sourceIds([{ source: 'cliniccloud', source_column: 'contacto_1.csv', value: '{"contact":{"idContacto":"42"}}' }, { source: 'other', source_column: 'idContacto', value: '99' }]), ['42']); });
test('package hash covers every before image and allowed patch', () => { const { plan, snapshot } = fixture(); const operation = { ...candidates(plan, snapshot)[0], before, before_sha256: hash(before), identity_rows: links }; const value = { version: VERSION, source_account: 'cliniccloud-5880', automation_policy: 'hold', whatsapp_column_policy: 'ignored_no_consent_mutation', operations: [operation] }; value.package_sha256 = packageHash(value); validatePackage(value); value.operations[0].fields_patch.phone = '123456789'; assert.throws(() => validatePackage(value), /PACKAGE_HASH/); });
function sqlFixture(tamper = false) {
  const { plan, snapshot } = fixture();
  const operation = { ...candidates(plan, snapshot)[0], before, before_sha256: hash(before), identity_rows: links, identity_sha256: hash(links) };
  const state = { row: { ...before }, sql: [] };
  const connection = { query: async (sql, values) => {
    state.sql.push(sql);
    if (sql.startsWith('SELECT * FROM Pacientes')) return [[{ ...state.row }]];
    if (sql.startsWith('SELECT id, paciente_id')) return [links];
    if (sql.startsWith('UPDATE Pacientes')) { state.row.email = values[0]; state.row.updatedAt = '2026-09-07 10:00:00'; if (tamper) state.row.antecedentes = 'unintended'; return [{ affectedRows: 1 }]; }
    throw new Error('UNEXPECTED_SQL');
  } };
  return { state, connection, payload: { operations: [operation] } };
}
test('SQL mutation is scoped by PK and rechecks complete after image', async () => {
  const f = sqlFixture(); const { applyPatches } = require('../cliniccloud-import-contacts-apply');
  const result = await applyPatches(f.connection, f.payload);
  assert.equal(result.length, 1); assert.equal(f.state.row.email, 'test@example.invalid');
  assert.equal(f.state.sql.filter(sql => sql.startsWith('UPDATE')).length, 1);
  assert.match(f.state.sql[0], /FOR UPDATE$/);
  assert.match(f.state.sql.find(sql => sql.startsWith('UPDATE')), /SET `email` = \?, updatedAt = UTC_TIMESTAMP\(\) WHERE id_paciente = \?$/);
});
test('unintended after-write changes stop before the caller commits', async () => {
  const f = sqlFixture(true); const { applyPatches } = require('../cliniccloud-import-contacts-apply');
  await assert.rejects(applyPatches(f.connection, f.payload), /POST_WRITE_VERIFICATION_FAILED/);
});
test('row drift prevents even the first SQL update', async () => {
  const f = sqlFixture(); f.state.row.telefono_movil = '611111111'; const { applyPatches } = require('../cliniccloud-import-contacts-apply');
  await assert.rejects(applyPatches(f.connection, f.payload), /PATIENT_FIELDS_DRIFT/);
  assert.equal(f.state.sql.filter(sql => sql.startsWith('UPDATE')).length, 0);
});
