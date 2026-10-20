'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { enrollmentRequest, freezeProgramEnrollment, readProgramEnrollment, enrollmentDto } = require('../../lib/patient-program-enrollment');
const { createPatientProgramEnrollmentService } = require('../../services/patientProgramEnrollment.service');
const clone = value => JSON.parse(JSON.stringify(value));
const PROGRAM = '9c175afe-bbb9-4625-bb7d-c9ea80e161aa';
const profile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 0, exemption_reason: 'Ficticio QA' };
function program() {
  return { id: PROGRAM, clinic_id: 100, version: 1, kind: 'program', status: 'active', name: 'Programa ficticio sin presupuesto',
    commercial_ready: true, total_price: 150, price_profile: profile, summary: { issues: [] }, appointments: [0, 15, 30].map((offset_days, i) => ({
      key: 's' + i, label: 'Sesión ' + i, offset_days, treatment_ids: [30], duration_minutes: 30, treatments: [{ id: 30, name: 'Ficticio', duration_minutes: 30,
        price_profile: profile, booking_profile: { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [101],
          professionals: { mode: 'any', ids: [1], preferred_id: 1 } }] } }] })) };
}
const payload = (request_key = 'enrollment-test-0001', extra = {}) => ({ clinic_id: 100, program_id: PROGRAM, program_version: 1, request_key, ...extra });
const request = () => enrollmentRequest(payload(), { clinicId: 100, patientId: 1, actorId: 1 });
const voucher = (sealed = freezeProgramEnrollment(program(), request(), new Date('2030-01-01Z'))) => ({ id: 1, public_id: 'qa-voucher', clinic_id: 100, patient_id: 1,
  budget_id: null, budget_line_key: null, created_by: 1, source_system: 'treatment_program', source_reference: 'program-enrollment:enrollment-test-0001',
  activation_rule: 'manual', sold_amount: 0, total_units: 3, available_units: 3, status: 'active', program_snapshot: sealed });
function fixture() {
  const rows = [], events = [], calls = [], state = { catalog: program(), enabled: true, linked: false };
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  const db = { sequelize: { transaction: async (options, fn) => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Clinica: { findByPk: async id => Number(id) === 100 ? { id_clinica: 100 } : null },
    Paciente: { findOne: async ({ where }) => where.id_paciente === 1 || where.public_id === 'ficticio' ? { id_paciente: 1, clinica_id: 100 }
      : where.id_paciente === 2 ? { id_paciente: 2, clinica_id: 200 } : null },
    PacienteClinica: { findOne: async () => state.linked ? { id: 1 } : null },
    PatientVoucher: { findOne: async ({ where }) => rows.find(row => matches(row, where)) || null,
      findAll: async ({ where }) => rows.filter(row => matches(row, where)), create: async value => { const row = { ...clone(value), id: rows.length + 1 }; rows.push(row); return row; } },
    PatientOperationalEvent: { create: async value => { events.push(value); return value; } } };
  for (const name of ['EconomicBudget', 'EconomicBudgetVersion', 'EconomicPayment', 'FiscalDocument', 'PatientVoucherMovement',
    'PatientConsentDocument', 'ConsentSignaturePackage', 'ConsentDeliveryEvent', 'JobRequest', 'FlowExecutionV2', 'Message']) {
    db[name] = new Proxy({}, { get: (_, method) => () => { calls.push(name + '.' + String(method)); throw Error('Forbidden side effect'); } });
  }
  const service = createPatientProgramEnrollmentService({ db, enabled: () => state.enabled, capabilities: () => ({ simple: true, multi: true, relativeSteps: true }),
    programs: { resolveForBudget: async args => { state.lastResolve = args; return state.catalog; } },
    now: () => new Date('2030-01-01Z'), newId: () => 'd31780e1-6a9f-442e-863c-d7e9ef391ad6' });
  const assign = (body = payload(), overrides = {}) => service.assign({ patientIdentifier: 'ficticio', clinicId: 100, actorId: 1, payload: body, ...overrides });
  return { db, rows, events, calls, state, assign };
}

test('clinical assignment freezes complete server snapshot, no budget/acceptance/payment/signature/outbound or unit movement', async () => {
  const f = fixture(), result = await f.assign();
  assert.equal(result.commercial_status, 'not_contracted'); assert.equal(result.sold_amount, null); assert.equal(result.catalog_reference_amount, 150);
  assert.equal(result.can_schedule, true); assert.equal(result.replayed, false); assert.equal(f.rows.length, 1); assert.equal(f.events.length, 1);
  assert.equal(f.rows[0].budget_id, null); assert.equal(f.rows[0].sold_amount, 0); assert.equal(f.rows[0].available_units, 3);
  const sealed = readProgramEnrollment(f.rows[0], { required: true });
  assert.equal(sealed.enrollment.source, 'program_enrollment'); assert.equal(sealed.appointments[2].offset_days, 30);
  assert.deepEqual(sealed.appointments[0].booking_profile.phases[0].installation_ids, [101]);
  assert.equal(f.events[0].event_type, 'program.enrolled'); assert.equal(f.events[0].metadata.budget_created, false); assert.deepEqual(f.calls, []);
});
test('exact replay survives catalog version changes; actor/intent mismatch and duplicate active enrollment reject', async () => {
  const f = fixture(); await f.assign(); f.state.catalog.version = 2; f.state.catalog.status = 'draft';
  assert.equal((await f.assign()).replayed, true); assert.equal(f.events.length, 1);
  for (const [body, overrides] of [[payload(), { actorId: 2 }], [payload('enrollment-test-0001', { program_version: 2 }), {}]]) {
    await assert.rejects(f.assign(body, overrides), error => error.code === 'program_enrollment_request_conflict');
  }
  await assert.rejects(f.assign(payload('enrollment-new-key')), error => error.code === 'program_enrollment_already_active'
    && error.details.voucher_id === f.rows[0].public_id);
  f.rows[0].status = 'consumed'; f.state.catalog.status = 'active';
  const second = await f.assign(payload('enrollment-new-key', { program_version: 2 }));
  assert.equal(second.program_version, 2); assert.equal(f.rows.length, 2); assert.equal(f.rows[0].program_snapshot.program_version, 1);
});
test('scope, patient membership, runtime, catalog version, fiscal and resources fail closed', async () => {
  const cases = [
    f => { f.state.enabled = false; return f.assign(); },
    f => f.assign(payload(), { clinicId: 200 }),
    f => f.assign(payload(), { patientIdentifier: 2 }),
    f => { f.state.catalog.clinic_id = 200; return f.assign(); },
    f => { f.state.catalog.version = 2; return f.assign(); },
    f => { f.state.catalog.status = 'draft'; return f.assign(); },
    f => { f.state.catalog.price_profile = null; f.state.catalog.appointments.forEach(a => a.treatments.forEach(t => { t.price_profile = null; })); return f.assign(); },
    f => { f.state.catalog.appointments[0].treatments[0].booking_profile.phases[0].installation_ids = []; return f.assign(); },
  ];
  for (const run of cases) { const f = fixture(); await assert.rejects(run(f)); assert.equal(f.rows.length, 0); assert.equal(f.events.length, 0); assert.deepEqual(f.calls, []); }
});
test('client cannot forge origin, budget, snapshot, price, saldo or activation', async () => {
  for (const key of ['program_snapshot', 'budget_id', 'source_system', 'sold_amount', 'available_units', 'status', 'price_profile', 'activation_rule']) {
    const f = fixture(); await assert.rejects(f.assign(payload('enrollment-test-0001', { [key]: null })), error => error.code === 'program_enrollment_request_invalid'); assert.equal(f.rows.length, 0);
  }
  for (const extra of [{ program_version: '1' }, { request_key: 'a' }, { program_id: 'not-a-program' }]) {
    assert.throws(() => enrollmentRequest(payload('enrollment-test-0001', extra), { clinicId: 100, patientId: 1, actorId: 1 }));
  }
});
test('snapshot scope, economic-origin conflict and all signed facts are validated', () => {
  assert.equal(readProgramEnrollment({ program_snapshot: null }), null);
  for (const mutate of [v => { v.patient_id = 2; }, v => { v.clinic_id = 200; }, v => { v.created_by = 2; }, v => { v.budget_id = 1; },
    v => { v.budget_line_key = 'line'; }, v => { v.sold_amount = 5; }, v => { v.source_reference += 'x'; }, v => { v.total_units = 8; },
    v => { v.program_snapshot.appointments[0].offset_days = 100; }, v => { v.program_snapshot.enrollment.request_sha256 = 'a'.repeat(64); },
    v => { v.program_snapshot.enrollment.actor_id = 2; }, v => { v.program_snapshot = '{}'; }]) {
    const row = voucher(); mutate(row); assert.throws(() => readProgramEnrollment(row, { required: true }));
  }
  const row = voucher(); assert.equal(enrollmentDto(row, readProgramEnrollment(row)).sold_amount, null);
});
test('model prevents replacing or removing an existing snapshot while allowing normal balance/status updates', async () => {
  const sql = new S.Sequelize('mysql://qa:unused@127.0.0.1/qa', { logging: false });
  try {
    const V = require('../../../models/patientvoucher')(sql, S.DataTypes), row = V.build(voucher(), { isNewRecord: false });
    row.changed('program_snapshot', false); row.available_units = 2; await V.runHooks('beforeUpdate', row, {});
    row.program_snapshot = null;
    await assert.rejects(V.runHooks('beforeUpdate', row, {}), error => error.code === 'PROGRAM_ENROLLMENT_SNAPSHOT_IMMUTABLE');
    await assert.rejects(V.runHooks('beforeBulkUpdate', { attributes: { program_snapshot: null } }), error => error.code === 'PROGRAM_ENROLLMENT_SNAPSHOT_IMMUTABLE');
    await V.runHooks('beforeBulkUpdate', { attributes: { status: 'consumed' } });
  } finally { await sql.close(); }
});
test('workspace serializer distinguishes clinical assignment from a free or paid economic purchase', () => {
  const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
  const file = require.resolve('../../services/patientEconomics.service'), local = createRequire(file);
  const source = fs.readFileSync(file, 'utf8'), start = source.indexOf('function serializeVoucher('), end = source.indexOf('\nfunction serializeFiscalDocument', start);
  const context = { require: local, numberValue: value => Number(value || 0), economicPrograms: { integrationCapabilities: () => ({ program_batch_booking: true }) } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.serialize = serializeVoucher;', context);
  const row = voucher(), result = context.serialize(row, []);
  assert.equal(result.sold_amount, null); assert.equal(result.budget_id, null); assert.equal(result.commercial_status, 'not_contracted');
  assert.equal(result.catalog_reference_amount, 150); assert.equal(result.origin, 'program_enrollment');
  const normal = context.serialize({ ...row, source_system: 'clinicaclick', program_snapshot: null, sold_amount: 80 }, []);
  assert.equal(normal.sold_amount, 80); assert.equal(normal.commercial_status, undefined);
});
test('release preflight requires JSON NULL snapshot and exact migration without inventing legacy table attributes', () => {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const { compare } = require('../../lib/securitySchemaContract'), schema = require('../../../ops/security/schema-contract.json');
  const required = schema.tables.PatientVouchers;
  assert.equal(Object.hasOwn(required, 'ENGINE'), false); assert.equal(Object.hasOwn(required, 'TABLE_COLLATION'), false);
  const contract = { tables: { PatientVouchers: required }, migrations: [] };
  const actual = { tables: [{ TABLE_NAME: 'PatientVouchers', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' }],
    columns: required.columns.map(column => ({ TABLE_NAME: 'PatientVouchers', ...column })), indexes: [], migrations: [] };
  assert.equal(compare(actual, contract).compatible, true);
  for (const change of [value => { value.columns = []; }, value => { value.columns[0].COLUMN_TYPE = 'longtext'; }, value => { value.columns[0].IS_NULLABLE = 'NO'; }]) {
    const changed = clone(actual); change(changed); assert.equal(compare(changed, contract).compatible, false);
  }
  assert.equal(compare(actual, { ...contract, tables: { PatientVouchers: { ...required, ENGINE: 'MyISAM' } } }).compatible, false);
  const name = '20261020170000-add-patient-program-enrollment-snapshot.js';
  assert.equal(schema.migrations.find(row => row.name === name).sha256,
    crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../../../migrations/' + name))).digest('hex'));
});
module.exports = { program, payload, PROGRAM };
