'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const core = require('../../lib/cliniccloud-import/patient-history-archive');
const patient = { id_paciente: 10, clinica_id: 66, nombre: 'Nombre actual', apellidos: '', dni: null,
  email: 'actual@example.invalid', telefono_movil: null, telefono_secundario: null, sexo: null,
  profesion: null, fecha_nacimiento: null, updatedAt: '2026-10-01 10:00:00' };
const contact = { IDCONTACTO: '20001', NOMBRE: 'Nombre origen', APELLIDOS: 'Ficticio', DNI: 'EXAMPLE001',
  EMAIL: 'origen@example.invalid', 'TELF. MOVIL': '+34 600 000 001', 'TELF. FIJO': '',
  SEXO: 'M', PROFESION: 'Profesión ficticia', 'F. NACIMIENTO': '20/05/1980', ALTA: '01/10/2026',
  DOMICILIO: 'Calle ficticia', WHATSAPP: 'Sí', RGPD: 'Sí', PUBLICIDAD: 'Sí' };
const link = { id: 1, paciente_id: 10, clinica_id: 66, source: 'cliniccloud', source_column: 'idContacto', field_key: 'cliniccloud_source_contact_id', value: '20001' };
const membership = { id: 1, paciente_id: 10, clinica_id: 66, es_principal: 1 };
function fixture(overrides = {}) { return { source: { account: core.SOURCE_ACCOUNT, name: 'BACKUP_CONTACTOS_2026-10-03.csv', date: '2026-10-03', sha256: hash('fixture'), rows: [{ source_row: 2, values: contact }] },
  patients: [patient], sourceLinks: [link], memberships: [membership], today: '2026-10-10', ...overrides }; }

test('retain full source, fill only blank canonical demographics, never permissions', () => {
  const plan = core.buildArchivePlan(fixture()); core.validatePlan(plan);
  const op = plan.operations[0], snapshot = JSON.parse(op.value);
  assert.deepEqual(snapshot.contact, contact); assert.equal(snapshot.provenance.source_file_name, 'BACKUP_CONTACTOS_2026-10-03.csv');
  assert.equal(op.fields_patch.sexo, 'hombre'); assert.equal(op.fields_patch.fecha_nacimiento, '1980-05-20');
  assert.equal(op.fields_patch.nombre, undefined); assert.equal(op.fields_patch.email, undefined);
  assert(!Object.keys(op.fields_patch).some(key => /whatsapp|rgpd|consent|publicidad|nota/i.test(key)));
  assert.equal(plan.policy.messages_sent, 0); assert.equal(plan.policy.economic_changes, 0);
});
test('source M/F maps to the existing UI enums without interpretation of unknown values', () => {
  assert.equal(core.nativePatch(patient, { ...contact, SEXO: 'F' }, { today: '2026-10-10' }).sexo, 'mujer');
  assert.equal(core.nativePatch(patient, { ...contact, SEXO: '?' }, { today: '2026-10-10' }).sexo, undefined);
});
test('never match unlinked patients by name, telephone or history number', () => {
  const plan = core.buildArchivePlan(fixture({ sourceLinks: [] }));
  assert.equal(plan.operations.length, 0); assert.equal(plan.holds[0].reason, 'unlinked_source_identity');
});
test('global source identity ambiguity and document disagreement are held', () => {
  const ambiguous = core.buildArchivePlan(fixture({ sourceLinks: [link, { ...link, id: 2, paciente_id: 99, clinica_id: 74 }] }));
  assert.equal(ambiguous.holds[0].reason, 'ambiguous_source_owner');
  const mismatch = core.buildArchivePlan(fixture({ patients: [{ ...patient, dni: 'OTHER999' }] }));
  assert.equal(mismatch.holds[0].reason, 'source_document_differs_from_current_patient');
});
test('scope requires the original source link and a real BS patient membership', () => {
  const plan = core.buildArchivePlan(fixture({ patients: [{ ...patient, clinica_id: 74 }], memberships: [] }));
  assert.equal(plan.operations.length, 0); assert.equal(plan.holds[0].reason, 'source_link_without_real_clinic_membership');
});
test('birth date omissions remain held, and invalid/future/impossible dates are not filled', () => {
  const held = core.buildArchivePlan(fixture({ birthDateHolds: [10] }));
  assert.equal(held.operations[0].fields_patch.fecha_nacimiento, undefined);
  for (const invalid of ['31/02/1980', '11/10/2026', '01/01/2027', '01/01/1880']) {
    assert.equal(core.nativePatch(patient, { ...contact, 'F. NACIMIENTO': invalid }, { today: '2026-10-10' }).fecha_nacimiento, undefined);
  }
});
test('aliases remain separate source records, but no alias chooses native demographics', () => {
  const f = fixture(); f.source.rows.push({ source_row: 3, values: { ...contact, IDCONTACTO: '20002', NOMBRE: 'Otro nombre' } });
  f.sourceLinks.push({ ...link, id: 2, value: '20002' });
  const plan = core.buildArchivePlan(f); core.validatePlan(plan);
  assert.equal(plan.operations.length, 2); assert(plan.operations.every(op => Object.keys(op.fields_patch).length === 0));
  assert.notEqual(plan.operations[0].field_key, plan.operations[1].field_key);
});
test('an absent, held or already archived alias still prevents native demographic selection', () => {
  const f = fixture({ sourceLinks: [link, { ...link, id: 2, value: '20002' }] });
  const absent = core.buildArchivePlan(f); assert.deepEqual(absent.operations[0].fields_patch, {});
  f.source.rows.push({ source_row: 3, values: { ...contact, IDCONTACTO: '20002', DNI: 'DIFFERENT999' } });
  f.patients = [{ ...patient, dni: contact.DNI }];
  const held = core.buildArchivePlan(f); assert.equal(held.operations.length, 1); assert.deepEqual(held.operations[0].fields_patch, {});
  assert.equal(held.holds[0].reason, 'source_document_differs_from_current_patient');
});
test('archives are immutable and idempotent', () => {
  const first = core.buildArchivePlan(fixture()), op = first.operations[0];
  const existing = { paciente_id: op.patient_id, clinica_id: op.clinic_id, field_key: op.field_key, value: op.value };
  const complete = { ...patient, ...op.fields_patch };
  const repeat = core.buildArchivePlan(fixture({ patients: [complete], existingArchives: [existing] }));
  assert.equal(repeat.operations.length, 0); assert.equal(repeat.unchanged.length, 1);
  const changed = core.buildArchivePlan(fixture({ existingArchives: [{ ...existing, value: '{}' }] }));
  assert.equal(changed.holds[0].reason, 'immutable_archive_conflict');
});
test('duplicate IDs, oversized TEXT, wrong source and stale/tampered plans fail closed', () => {
  const f = fixture(); f.source.rows.push({ ...f.source.rows[0], source_row: 3 });
  assert.equal(core.buildArchivePlan(f).operations.length, 0);
  const large = fixture(); large.source.rows[0] = { source_row: 2, values: { ...contact, NOTAS: 'x'.repeat(70000) } };
  assert.equal(core.buildArchivePlan(large).holds[0].reason, 'source_record_exceeds_text_storage_limit');
  assert.throws(() => core.buildArchivePlan(fixture({ source: { ...fixture().source, account: 'other' } })), /SOURCE_SCOPE/);
  const plan = core.buildArchivePlan(fixture()); assert.throws(() => core.validatePlan({ ...plan, today: '2030-01-01' }), /PROOF_INVALID/);
  const { plan_sha256, ...body } = plan; body.prepared_at = 'not-a-date';
  assert.throws(() => core.validatePlan({ ...body, plan_sha256: hash(body) }), /PLAN_STALE/);
});

module.exports = { fixture, patient, contact, link, membership };
