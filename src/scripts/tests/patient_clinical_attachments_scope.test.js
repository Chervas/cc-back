'use strict';
// VM-only service harness. No model index, app bootstrap, database, storage
// files or remote network can be loaded by the service under test.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const file = require.resolve('../../services/patientClinicalAttachments.service');
const Op = { in: Symbol('in'), or: Symbol('or') };
const plain = value => JSON.parse(JSON.stringify(value));
const asset = (id, clinic = 66, purpose = 'clinical_attachment', patch = {}) => ({ id, public_id: 'OWNED-ASSET-' + id,
  patient_id: 10, clinic_id: clinic, scope_type: 'clinic', purpose, status: 'active', original_filename: 'fictitious-' + id + '.pdf',
  content_type: 'application/pdf', size_bytes: 1, created_at: '2026-10-01T00:00:00Z', ...patch });
function fixture({ assets = [asset(1), asset(2, 72)], primary = 66,
  memberships = [{ paciente_id: 10, clinica_id: 66 }, { paciente_id: 10, clinica_id: 72 }],
  grants = { 66: ['patients.sensitive.view'] }, hasMembershipModel = true } = {}) {
  const calls = { patients: [], memberships: [], queries: [], acl: [], reads: [], writes: [] };
  const patient = { id_paciente: 10, public_id: 'OWNED-PATIENT', clinica_id: primary };
  const matches = (row, where) => Reflect.ownKeys(where).every(key => key === Op.or
    ? where[key].some(clause => matches(row, clause))
    : where[key] && typeof where[key] === 'object' && Object.hasOwn(where[key], Op.in)
      ? where[key][Op.in].includes(row[key]) : row[key] === where[key]);
  const db = { Clinica: {},
    Paciente: { findOne: async query => { calls.patients.push(query); return matches(patient, query.where) ? patient : null; } },
    ...(hasMembershipModel ? { PacienteClinica: { findAll: async query => { calls.memberships.push(query); return memberships; } } } : {}),
    ClinicalPrivateAsset: {
      findAll: async query => { calls.queries.push(query); return assets.filter(row => matches(row, query.where)).slice(0, query.limit); },
      findOne: async query => { calls.queries.push(query); return assets.find(row => matches(row, query.where)) || null; },
    }, CitaPaciente: { findOne: async query => matches({ id_cita: 1, paciente_id: 10, clinica_id: primary }, query.where) ? { id_cita: 1 } : null },
  };
  const storage = {
    readClinicalPrivateAsset: async row => { calls.reads.push(row); return { asset: row, buffer: Buffer.from('FICTITIOUS') }; },
    storeClinicalPrivateAsset: async input => { calls.writes.push(input); return asset(99, input.clinicId, input.purpose,
      { owner_type: input.ownerType, owner_id: input.ownerId, metadata: input.metadata }); },
  };
  const sandbox = { module: { exports: {} }, Buffer, require: name => {
    if (name === 'path') return path;
    if (name === 'sequelize') return { Op };
    if (name === '../../models') return db;
    if (name === './clinicalPrivateStorage.service') return storage;
    if (name === '../lib/access-policy') return { canUserAccessFeature: async input => {
      calls.acl.push(input); return input.actorId === 9 && (grants[input.clinicId] || []).includes(input.featureKey);
    } };
    throw Error('UNEXPECTED_DEPENDENCY: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return { service: sandbox.module.exports, calls, patient, db, grants };
}
test('partial clinic reader sees only authorized assets, query couples clinic with purpose and preserves limit200', async () => {
  const f = fixture(), listed = await f.service.listPatientClinicalAttachments('10', 9);
  assert.deepEqual(plain(listed.items.map(row => row.id)), [1]);
  const query = f.calls.queries[0];
  assert.equal(query.where.patient_id, 10); assert.equal(query.where.status, 'active'); assert.equal(query.where.scope_type, 'clinic');
  assert.equal(query.limit, 200); assert.equal(query.where[Op.or].length, 1);
  assert.equal(query.where[Op.or][0].clinic_id, 66);
  assert.deepEqual(plain(query.where[Op.or][0].purpose[Op.in]), ['clinical_attachment']);
  assert.equal(f.calls.memberships[0].where.paciente_id, 10);
  await assert.rejects(f.service.readPatientClinicalAttachment('10', 'OWNED-ASSET-2', 9),
    error => error.status === 403 && error.details.clinic_id === 72);
  assert.equal(f.calls.reads.length, 0, 'Denied reader never reaches private storage');
});
test('secondary-only reader works for actual shared patient ID without a primary-clinic grant', async () => {
  const f = fixture({ grants: { 72: ['patients.sensitive.view'] } });
  const listed = await f.service.listPatientClinicalAttachments('OWNED-PATIENT', 9);
  assert.deepEqual(plain(listed.items.map(row => row.id)), [2]);
  const read = await f.service.readPatientClinicalAttachment('OWNED-PATIENT', '2', 9);
  assert.equal(read.asset.clinic_id, 72);
  assert.equal(f.calls.acl[f.calls.acl.length - 1].clinicId, 72, 'Download evaluates the asset clinic, not primary66');
});
test('reader of both clinics sees both; each purpose retains its own clinic-specific permission', async () => {
  const rows = [asset(1), asset(2, 72), asset(3, 66, 'consent_document_pdf'),
    asset(4, 72, 'consent_document_pdf'), asset(5, 72, 'nutrition_report_pdf')];
  const f = fixture({ assets: rows, grants: { 66: ['patients.sensitive.view', 'consents.view'],
    72: ['patients.sensitive.view', 'nutrition.workspace.view'] } });
  assert.deepEqual(plain((await f.service.listPatientClinicalAttachments('10', 9)).items.map(row => row.id)), [1, 2, 3, 5]);
  for (const id of [1, 2, 3, 5]) await f.service.readPatientClinicalAttachment('10', String(id), 9);
  await assert.rejects(f.service.readPatientClinicalAttachment('10', '4', 9), error => error.status === 403
    && error.details.feature_key === 'consents.view' && error.details.clinic_id === 72);
  assert.equal(f.calls.reads.length, 4);
});
test('same group or actor grant does not create a patient-clinic relationship', async () => {
  const f = fixture({ assets: [asset(1), asset(2, 82)], memberships: [{ paciente_id: 10, clinica_id: 66 },
    { paciente_id: 999, clinica_id: 82 }], grants: { 66: ['patients.sensitive.view'], 82: ['patients.sensitive.view'] } });
  assert.deepEqual(plain((await f.service.listPatientClinicalAttachments('10', 9)).items.map(row => row.id)), [1]);
  await assert.rejects(f.service.readPatientClinicalAttachment('10', '2', 9), error => error.status === 403);
  assert.equal(f.calls.reads.length, 0); assert(!f.calls.acl.some(call => call.clinicId === 82));
});
test('group, system, missing/unknown scopes and purposes fail closed even with every clinic feature', async () => {
  const rows = [asset(1), asset(2, 66, 'clinical_attachment', { scope_type: 'group', group_id: 50 }),
    asset(3, null, 'clinical_attachment', { scope_type: 'system' }), asset(4, 66, 'clinical_attachment', { scope_type: null }),
    asset(5, 66, 'clinical_attachment', { scope_type: 'unknown' }), asset(6, 66, 'unrecognized_private_purpose')];
  const f = fixture({ assets: rows, grants: { 66: ['patients.sensitive.view', 'consents.view', 'nutrition.workspace.view'] } });
  assert.deepEqual(plain((await f.service.listPatientClinicalAttachments('10', 9)).items.map(row => row.id)), [1]);
  for (const id of [2, 3, 4, 5, 6]) await assert.rejects(f.service.readPatientClinicalAttachment('10', String(id), 9), error => error.status === 403);
  assert.equal(f.calls.reads.length, 0);
});
test('primary legacy membership remains valid; malformed or unrelated memberships cannot grant scope', async () => {
  const f = fixture({ memberships: [{ paciente_id: 10, clinica_id: '72garbage' }, { paciente_id: 11, clinica_id: 72 }] });
  assert.deepEqual(plain((await f.service.listPatientClinicalAttachments('10', 9)).items.map(row => row.id)), [1]);
  const legacy = fixture({ hasMembershipModel: false });
  assert.deepEqual(plain((await legacy.service.listPatientClinicalAttachments('10', 9)).items.map(row => row.id)), [1]);
  await legacy.service.readPatientClinicalAttachment('10', '1', 9); assert.equal(legacy.calls.reads.length, 1);
});
test('patient ID and active status are required even with an authorized asset clinic', async () => {
  const f = fixture({ assets: [asset(1), asset(2, 66, 'clinical_attachment', { patient_id: 11 }),
    asset(3, 66, 'clinical_attachment', { status: 'deleted' })] });
  assert.deepEqual(plain((await f.service.listPatientClinicalAttachments('10', 9)).items.map(row => row.id)), [1]);
  for (const id of [2, 3]) await assert.rejects(f.service.readPatientClinicalAttachment('10', String(id), 9), error => error.status === 404);
  await assert.rejects(f.service.listPatientClinicalAttachments('11', 9), error => error.status === 404);
  assert.equal(f.calls.reads.length, 0);
});
test('no grants performs no asset query and returns an empty list', async () => {
  const f = fixture({ grants: {} });
  const result = await f.service.listPatientClinicalAttachments('10', 9);
  assert.equal(result.summary.total, 0); assert.equal(f.calls.queries.length, 0);
  await assert.rejects(f.service.readPatientClinicalAttachment('10', '1', 8), error => error.status === 403);
  assert.equal(f.calls.reads.length, 0);
});
test('limit200 remains bounded; query scope applies before limit and unauthorized documents consume no capacity', async () => {
  const rows = [...Array.from({ length: 250 }, (_, i) => asset(i + 1, 72)),
    ...Array.from({ length: 205 }, (_, i) => asset(1000 + i, 66))];
  const f = fixture({ assets: rows }); const result = await f.service.listPatientClinicalAttachments('10', 9);
  assert.equal(result.items.length, 200); assert(result.items.every(row => row.clinic_id === 66));
  assert.equal(f.calls.queries[0].limit, 200);
});
test('upload still requires primary patients.edit and cannot use secondary read/edit to expand creation scope', async () => {
  const payload = { filename: 'fictitious.pdf', content_type: 'application/pdf', data_base64: Buffer.from('FICTITIOUS').toString('base64'), clinic_id: 72 };
  const secondary = fixture({ grants: { 72: ['patients.edit', 'patients.sensitive.view'] } });
  await assert.rejects(secondary.service.createPatientClinicalAttachment('10', 9, payload), error => error.status === 403
    && error.details.feature_key === 'patients.edit' && error.details.clinic_id === 66);
  assert.equal(secondary.calls.writes.length, 0); assert.equal(secondary.calls.memberships.length, 0);
  const primary = fixture({ grants: { 66: ['patients.edit'] } });
  const created = await primary.service.createPatientClinicalAttachment('10', 9, payload);
  assert.equal(created.clinic_id, 66); assert.equal(primary.calls.writes[0].clinicId, 66);
  assert.equal(primary.calls.writes[0].patientId, 10); assert.equal(primary.calls.memberships.length, 0);
});
