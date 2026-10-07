'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Sequelize, DataTypes: D } = require('sequelize');
const v = require('../../lib/appointment-visit-communication');
const r = require('../../lib/appointment-visit-runtime-contract');
const { combinedAppointment, NOW } = require('./helpers/appointment-visit-fixture');
const f = require('./helpers/appointment-visit-runtime-fixture');
const clone = structuredClone;
test('contract is an opaque server token; JSON/newAppointment booleans cannot enroll', () => {
  const token = f.contract(), data = r.compiledContract(token);
  assert.equal(data.schema, r.CONTRACT);
  assert.equal(data.manifests[0].stages.length, 3);
  for (const invalid of [clone(token), data, { newAppointment: true }, null]) {
    assert.throws(() => r.compiledContract(invalid), { code: 'appointment_visit_runtime_server_contract_required' });
  }
  data.manifests.length = 0;
  assert.equal(r.compiledContract(token).manifests.length, 1);
});
test('whole server-owned graph must map every patient send, wait and appointment mutation', () => {
  for (const mutate of [value => value.nodes.push({ id: 'X', type: 'action/send_whatsapp', outputs: {} }),
    value => { value.nodes[4].type = 'action/send_email'; },
    value => { value.nodes[5].type = 'action/change_status'; value.nodes[5].config = { target_entity: 'appointment', new_status: 'cancelada' }; },
    value => { value.nodes[1].outputs.next = 'missing'; },
    value => { value.nodes[2].config.listens_to_node_id = 'A'; },
    value => { value.nodes[4].type = 'action/unknown_clinical_action'; }]) {
    const value = f.template(); mutate(value);
    if (value.nodes.some(node => node.id === 'X')) value.nodes[0].outputs.extra = 'X';
    assert.throws(() => f.contract(value));
  }
});
test('one stage has exactly one send; unsupported email/stage/wait policy fails before birth', () => {
  const value = f.template();
  for (const mutate of [stages => { stages[0].node_ids.push('A'); },
    stages => { stages[0].key = 'week_before'; },
    stages => { delete stages[2].timeout_grace_ms; },
    stages => { stages[1].timeout_grace_ms = 1; },
    stages => { stages[1].source_key = 'attendance_day_before'; }]) {
    const stages = f.stages(); mutate(stages);
    assert.throws(() => r.compileEnrollmentContract({ clinicId: 66, timeZone: 'UTC', manifests: [{ template: value, stages }] }));
  }
  assert.throws(() => r.waitDuration({ config: { timeout_duration: 8, timeout_unit: 'days' } }));
});
test('21:00 unconfirmed warning, week-before, unpublished/inactive/scope-mixed graphs are not silently remapped', () => {
  for (const patch of [{ trigger_config: { schedule_moment: 'night_before', only_if_not_confirmed: true }, trigger_type: 'appointment_reminder_window' },
    { trigger_config: { schedule_moment: 'day_before', only_if_not_confirmed: true }, trigger_type: 'appointment_reminder_window' },
    { trigger_config: { schedule_moment: 'week_before' }, trigger_type: 'appointment_reminder_window' },
    { is_active: false }, { published_at: null }, { clinic_id: 72 }, { clinic_id: null, group_id: 9 }]) {
    assert.throws(() => f.contract(f.template(patch), patch.trigger_type ? 'attendance_day_before' : 'details'));
  }
});
test('manifest can explicitly allow known status mutations, not infer clinical actions', () => {
  const value = f.template(); value.nodes[5] = { id: 'E', type: 'action/change_status', config: { target_entity: 'appointment', new_status: 'info_confirmada' }, outputs: {} };
  const token = r.compileEnrollmentContract({ clinicId: 66, timeZone: 'UTC', manifests: [{ template: value, stages: f.stages(), mutations: [{ node_id: 'E', new_status: 'info_confirmada' }] }] });
  assert.deepEqual(r.compiledContract(token).manifests[0].mutations, [{ node_id: 'E', new_status: 'info_confirmada' }]);
});
test('birth hash normalizes instants/plan order, omits irrelevant booking labels, changes for later phase geometry', () => {
  const base = f.plan(), hash = r.birthRequestHash({ clinicId: 66, patientId: 8, plan: base });
  const same = Object.fromEntries(Object.entries(clone(base)).reverse());
  same.start_at = '2030-01-07T11:00:00+01:00';
  same.booking.warnings = ['fixture-only']; same.booking.phases[1].doctor_names = ['fixture-only'];
  assert.equal(r.birthRequestHash({ clinicId: 66, patientId: 8, plan: same }), hash);
  for (const mutate of [p => { p.booking.phases[1].doctor_ids = [52]; }, p => { p.booking.phases[1].installation_id = 77; }]) {
    const changed = clone(base); mutate(changed);
    assert.notEqual(r.birthRequestHash({ clinicId: 66, patientId: 8, plan: changed }), hash);
  }
  assert.notEqual(r.birthRequestHash({ clinicId: 66, patientId: 9, plan: base }), hash);
  assert.throws(() => r.birthRequestHash({ clinicId: 66, patientId: 8, plan: { ...base, nota: 'not a request-hash right' } }));
});
test('enrollment is birth-only future native fully-verified multi-step v4; no source/history/PRP/HOLD/QA/voucher/program takeover', () => {
  r.assertBirthEligibility(combinedAppointment(), NOW);
  for (const mutate of [row => { row.source_system = 'cliniccloud'; }, row => { row.source_reference = 'fixture'; },
    row => { row.voucher_id = 1; }, row => { row.es_provisional = true; }, row => { row.hold_expires_at = NOW; },
    row => { row.import_metadata.program_session = {}; }, row => { row.import_metadata.clinical_component_parent = {}; },
    row => { row.import_metadata.historical_registration = true; }, row => { row.import_metadata.automation_policy = 'hold'; },
    row => { row.import_metadata.cliniccloud_source_booking = { synthetic_data_only: true }; },
    row => { row.import_metadata.notification_suppression = { same_day: true }; },
    row => { row.import_metadata.booking.capacity_fully_verified = false; },
    row => { row.import_metadata.booking.profile.version = 3; }]) {
    const row = combinedAppointment(); mutate(row); assert.throws(() => r.assertBirthEligibility(row, NOW));
  }
  assert.throws(() => r.assertBirthEligibility(combinedAppointment(), '2030-01-08T00:00:00Z'));
});
test('stage plans are opaque, tied to revision/enrollment/purpose/exact bounds, no caller window override', () => {
  const visit = f.enrolledVisit(), sealed = r.sealStagePlan({ visit, templateVersionId: 42, stageKey: 'details' });
  const window = { key: sealed.window.key, starts_at: sealed.window.starts_at, ends_at: sealed.window.ends_at };
  assert.equal(sealed.window.key, 'details');
  assert.equal(r.stagePlan(sealed.token, visit, 'appointment_details', window).stored.node_ids[0], 'S');
  for (const [token, row, purpose, candidateWindow] of [[clone(sealed.token), visit, 'appointment_details', window],
    [sealed.token, { ...visit, communication_revision: 2 }, 'appointment_details', window],
    [sealed.token, visit, 'reminder_day_before', window],
    [sealed.token, visit, 'appointment_details', { ...window, ends_at: '2030-01-08T00:00:00Z' }]]) {
    assert.throws(() => r.stagePlan(token, row, purpose, candidateWindow));
  }
  assert.throws(() => r.semanticWindow({ visit: { ...visit, communication_revision: 2 }, templateVersionId: 42, stageKey: 'details' }), { code: 'appointment_visit_runtime_mutation_event_required' });
});
test('local calendar windows preserve DST and patient date; template/retry timestamp is not a new right', () => {
  const value = f.template({ trigger_type: 'appointment_reminder_window', trigger_config: { schedule_moment: 'day_before' } });
  for (const [date, hours] of [['2030-04-01', 23], ['2030-10-28', 25]]) {
    const row = combinedAppointment();
    row.inicio = date + 'T10:00:00Z'; row.fin = date + 'T10:45:00Z';
    for (const phase of row.import_metadata.booking.phases) { phase.start_at = date + phase.start_at.slice(10); phase.end_at = date + phase.end_at.slice(10); for (const interval of phase.staff_intervals) { interval.start_at = date + interval.start_at.slice(10); interval.end_at = date + interval.end_at.slice(10); } }
    const visit = f.enrolledVisit({ row, value, source: 'attendance_day_before' });
    const first = r.semanticWindow({ visit, templateVersionId: 42, stageKey: 'attendance_day_before' }).window;
    assert.equal(first.key, 'day_before:' + date);
    assert.equal((Date.parse(first.ends_at) - Date.parse(first.starts_at)) / 3600000, hours);
    assert.equal(v.normalizeWindow({ key: first.key, ends_at: first.ends_at, starts_at: new Date(Date.parse(first.starts_at) + 1000) }).sha256, first.sha256);
  }
});
test('ack/timeout windows derive only from accepted purpose wait and explicit manifest grace', () => {
  const visit = f.enrolledVisit(), wait = { schema: 'appointment-visit-purpose-wait/1', visit_id: visit.id, communication_revision: 1,
    stage_key: 'details', source_communication_id: randomUUID(), wait_node_id: 'W', starts_at: '2030-01-01T12:00:01.123Z',
    due_at: '2030-01-01T14:00:01.123Z', cutoff_at: visit.snapshot.patient_start_at };
  const ack = r.semanticWindow({ visit, templateVersionId: 42, stageKey: 'ack_details', sourceWait: wait }).window;
  const timeout = r.semanticWindow({ visit, templateVersionId: 42, stageKey: 'timeout_details', sourceWait: wait }).window;
  assert.equal(ack.key, 'ack:details'); assert.equal(ack.ends_at, wait.due_at);
  assert.equal(timeout.key, 'timeout:details'); assert.equal(timeout.starts_at, wait.due_at);
  assert.equal(timeout.ends_at, '2030-01-01T14:05:01.123Z');
  for (const patch of [{ communication_revision: 2 }, { stage_key: 'attendance_day_before' }, { visit_id: randomUUID() }]) assert.throws(() => r.semanticWindow({ visit, templateVersionId: 42, stageKey: 'ack_details', sourceWait: { ...wait, ...patch } }));
});
test('new actual Sequelize models match composed migrations/indexes/FKs/DATE3 without a connection', async () => {
  const sql = new Sequelize('mysql://fixture:fixture@127.0.0.1/fixture', { logging: false });
  const tables = new Map(), indexes = new Map(), qi = { async createTable(name, cols) { tables.set(name, cols); }, async addColumn(name, key, col) { tables.get(name)[key] = col; }, async addIndex(table, fields, opts) { indexes.set(opts.name, { table, fields, unique: opts.unique === true }); } };
  await require('../../../migrations/20261006130000-create-appointment-visit-communications').up(qi, D);
  await require('../../../migrations/20261007130000-add-appointment-visit-runtime-contracts').up(qi, D);
  for (const file of ['appointmentvisitbirthrequest', 'appointmentvisitdispatch']) {
    const model = require('../../../models/' + file)(sql, D), columns = tables.get(model.tableName);
    assert.deepEqual(Object.keys(model.rawAttributes).sort(), Object.keys(columns).sort());
    for (const [key, column] of Object.entries(columns)) {
      const type = typeof column.type === 'function' ? column.type() : column.type;
      assert.equal(model.rawAttributes[key].type.toString(), sql.normalizeDataType(type).toString(), key);
      assert.equal(model.rawAttributes[key].allowNull, column.allowNull, key);
      if (column.references) assert.deepEqual(model.rawAttributes[key].references, column.references);
    }
    for (const index of model.options.indexes) assert.deepEqual(indexes.get(index.name), { table: model.tableName, fields: index.fields, unique: index.unique === true });
  }
  const model = sql.models.AppointmentVisitDispatch;
  await assert.rejects(model.build({ status: 'retryable_unknown', job_attempt: 0 }).validate());
  await sql.close();
});
test('runtime migration rollback refuses enrollments/waits/stages/attempts/birth history before changing any schema', async () => {
  const migration = require('../../../migrations/20261007130000-add-appointment-visit-runtime-contracts');
  for (const populated of ['AppointmentVisitDispatches', 'AppointmentVisitBirthRequests', 'runtime_enrollment', 'runtime_stage', 'runtime_wait']) {
    const writes = [], q = { sequelize: { async query(sql) { return [[{ count: sql.includes('`' + populated + '`') ? 1 : 0 }]]; } }, async dropTable(table) { writes.push(table); }, async removeColumn(table, column) { writes.push(table + '.' + column); } };
    await assert.rejects(migration.down(q), /durable history/); assert.deepEqual(writes, []);
  }
});
