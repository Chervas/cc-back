'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const { randomUUID } = require('node:crypto');
const v = require('../../lib/appointment-visit-communication');
const { appointment, combinedAppointment, NOW } = require('./helpers/appointment-visit-fixture');
const migration = require('../../../migrations/20261006130000-create-appointment-visit-communications');

function snapshot(row = appointment(), id = randomUUID()) {
  return v.buildVisitSnapshot({ visitId: id, ownerAppointmentId: row.id_cita, appointments: [row], groupingKind: 'singleton',
    members: [{ visit_id: id, appointment_id: row.id_cita, clinic_id: row.clinica_id, patient_id: row.paciente_id, role: 'primary', evidence: {} }] });
}
test('canonical snapshots contain reservation identity, no patient content/economics/turnaround', () => {
  const projection = snapshot(appointment(101, { patient_name: 'Synthetic fixture', phone: 'fixture-only', precio: 120,
    import_metadata: { equipment_reservation: { equipment_end_at: '2030-01-07T12:00:00.000Z' } } }));
  const serialized = JSON.stringify(projection.snapshot);
  for (const field of ['nota', 'patient_name', 'phone', 'precio', 'import_metadata', 'updated_at', 'template_version']) assert(!serialized.includes(field));
  assert.equal(projection.snapshot.patient_start_at, '2030-01-07T10:15:00.000Z');
  assert.equal(projection.snapshot.patient_end_at, '2030-01-07T10:45:00.000Z');
  assert.equal(v.hash(projection.snapshot), projection.snapshot_sha256);
});
test('nonsemantic timestamps/template/confirmation status do not create revision fingerprints', () => {
  const id = randomUUID(), base = snapshot(appointment(), id);
  for (const patch of [{ updated_at: '2031-01-01T00:00:00.000Z' }, { template_version_id: 43 }, { estado: 'info_confirmada' },
    { estado: 'recordatorio_confirmado' }, { estado: 'reprogramada' }, { nota: 'Other fixture note' }]) {
    assert.equal(snapshot(appointment(101, patch), id).snapshot_sha256, base.snapshot_sha256);
  }
});
test('schedule, reserved resource, treatment and terminal lifecycle are semantic changes', () => {
  const id = randomUUID(), base = snapshot(appointment(), id);
  for (const patch of [{ inicio: '2030-01-07T10:20:00.000Z' }, { fin: '2030-01-07T10:50:00.000Z' },
    { doctor_id: 51 }, { instalacion_id: 76 }, { tratamiento_id: 689 }, { estado: 'cancelada' }, { estado: 'completada' }]) {
    const changed = snapshot(appointment(101, patch), id);
    assert.notEqual(changed.snapshot_sha256, base.snapshot_sha256);
    assert.equal(changed.membership_sha256, base.membership_sha256);
  }
});
test('group snapshot is stable under permutation and includes two IDs/roles and reciprocal evidence', () => {
  const id = randomUUID(), evidence = { component_appointment_id: 101, parent_appointment_id: 102, receipt_sha256: 'a'.repeat(64), audit_event_id: '9007199254740993' };
  const appointments = [appointment(101, { inicio: '2030-01-07T10:00:00.000Z', fin: '2030-01-07T10:15:00.000Z', tratamiento_id: null }), appointment(102)];
  const members = appointments.map(row => ({ visit_id: id, appointment_id: row.id_cita, clinic_id: 66, patient_id: 8,
    role: row.id_cita === 102 ? 'primary' : 'prp_extraction', evidence }));
  const args = { visitId: id, ownerAppointmentId: 102, groupingKind: 'validated_prp', evidence, appointments, members };
  const expected = v.buildVisitSnapshot(args);
  assert.deepEqual(v.buildVisitSnapshot({ ...args, appointments: appointments.toReversed ? appointments.toReversed() : [...appointments].reverse(), members: [...members].reverse() }), expected);
  assert.equal(expected.snapshot.patient_start_at, appointments[0].inicio);
  assert.equal(expected.snapshot.patient_end_at, appointments[1].fin);
  assert.equal(expected.snapshot.owner_appointment_id, 102);
  assert.throws(() => v.buildVisitSnapshot({ ...args, members: [members[0], { ...members[1], evidence: { ...evidence, receipt_sha256: 'b'.repeat(64) } }] }), { code: 'appointment_visit_invalid_membership' });
});
test('no singleton/timestamp/name inference; invalid IDs, scope, roles and intervals fail closed', () => {
  const id = randomUUID(), row = appointment(), member = { appointment_id: 101, visit_id: id, clinic_id: 66, patient_id: 8, role: 'primary', evidence: {} };
  const args = { visitId: id, ownerAppointmentId: 101, appointments: [row], members: [member], groupingKind: 'singleton' };
  for (const patch of [{ visitId: 'arbitrary' }, { ownerAppointmentId: 102 }, { members: [{ ...member, patient_id: 9 }] },
    { members: [{ ...member, role: 'prp_extraction' }] }, { appointments: [{ ...row, fin: row.inicio }] },
    { appointments: [row, { ...row, id_cita: 102 }], members: [member, { ...member, appointment_id: 102 }] }]) assert.throws(() => v.buildVisitSnapshot({ ...args, ...patch }));
  assert.throws(() => v.instant('2030-01-01T10:00:00'));
  assert.throws(() => v.object('{bad json}'));
});
test('window identity is semantic key, changed bounds do not grant another right', () => {
  const base = v.normalizeWindow({ key: 'day_before:2030-01-06', starts_at: NOW, ends_at: '2030-01-02T12:00:00.000Z' });
  assert.equal(v.normalizeWindow({ key: base.key, starts_at: '2030-01-01T14:00:00+02:00', ends_at: '2030-01-03T12:00:00.000Z' }).sha256, base.sha256);
  assert.throws(() => v.normalizeWindow({ key: 'bad key', starts_at: NOW, ends_at: NOW }));
  assert.throws(() => v.assertWindow(base, '2030-01-02T12:00:00.000Z'), { code: 'appointment_visit_window_expired' });
  assert.throws(() => v.assertWindow(base, '2030-01-01T11:59:59.999Z', true), { code: 'appointment_visit_window_not_open' });
  v.assertWindow(base, NOW, true);
});
test('HOLD/source/QA/provisional/manual suppression are checked on every member, JSON cannot override', () => {
  const row = appointment();
  for (const patch of [{ source_system: 'cliniccloud' }, { source_reference: 'fixture-source' }, { es_provisional: true },
    { import_metadata: { automation_policy: 'hold' } }, { import_metadata: { import: { messages_enabled: false } } },
    { import_metadata: { cliniccloud_reconciliation: { automation_policy: 'hold' } } },
    { import_metadata: { qa_demo: { id: 'fixture' } } }, { import_metadata: { synthetic_data_only: 'true' } },
    { import_metadata: { notification_suppression: { appointment_details: true } } },
    { import_metadata: { historical_registration: true } },
    { import_metadata: { cliniccloud_source_booking: { synthetic_data_only: true } } },
    { import_metadata: { context: { appointment: { qa_demo: 'fixture' } } } }]) {
    assert.throws(() => v.assertNotificationEligibility({ appointments: [row, { ...row, id_cita: 102, ...patch }],
      purpose: 'appointment_details', now: NOW, releaseForAppointment: { allowed: true } }));
  }
  for (const purpose of ['qa', 'migration', 'appointment_created_v43', '__proto__']) {
    assert.throws(() => v.purposePolicy(purpose), { code: 'appointment_visit_invalid_purpose' });
  }
  assert.throws(() => v.assertNotificationEligibility({ appointments: [appointment(101, { estado: 'cambio_solicitado' })], purpose: 'appointment_details', now: NOW }), { code: 'appointment_visit_purpose_ineligible' });
  v.assertNotificationEligibility({ appointments: [appointment(101, { estado: 'reprogramada' })], purpose: 'appointment_details', now: NOW });
});
test('Message outcome preserves provider acceptance and unknown independently of failed/cancelled labels', () => {
  for (const metadata of [{ wamid: 'fixture-provider-id' }, { provider_acceptance_at: NOW }]) assert.equal(v.messageOutcome({ direction: 'outbound', status: 'failed', metadata }), 'accepted');
  for (const metadata of [{ delivery_unknown: true }, { outcome_unknown: true }, { wa_response: { fixture: true } }]) assert.equal(v.messageOutcome({ direction: 'outbound', status: 'failed', metadata }), 'unknown');
  assert.equal(v.messageOutcome({ direction: 'outbound', status: 'sending' }), 'unknown');
  assert.equal(v.messageOutcome({ direction: 'outbound', status: 'failed' }), 'failed');
  assert.equal(v.messageOutcome({ direction: 'outbound', status: 'read' }), 'accepted');
  assert.throws(() => v.messageOutcome({ direction: 'inbound', status: 'sent' }), { code: 'appointment_visit_message_scope_changed' });
  assert(v.deliveryKey({ id: randomUUID() }).length <= 191);
});
test('additive migration and actual Sequelize model contracts match without opening a connection', async () => {
  const sequelize = new Sequelize('mysql://fixture:fixture@127.0.0.1/fixture', { logging: false });
  const factories = [require('../../../models/appointmentvisit'), require('../../../models/appointmentvisitmember'), require('../../../models/appointmentvisitcommunication')];
  const models = factories.map(factory => factory(sequelize, DataTypes));
  const tables = new Map(), indexes = new Map();
  await migration.up({ async createTable(name, columns) { tables.set(name, columns); },
    async addIndex(table, fields, opts) { indexes.set(opts.name, { table, fields, unique: opts.unique === true }); } }, DataTypes);
  assert.deepEqual([...tables.keys()], ['AppointmentVisits', 'AppointmentVisitMembers', 'AppointmentVisitCommunications']);
  await require('../../../migrations/20261007130000-add-appointment-visit-runtime-contracts').up({
    async addColumn(table, field, column) { tables.get(table)[field] = column; },
    async createTable(name, columns) { tables.set(name, columns); },
    async addIndex(table, fields, opts) { indexes.set(opts.name, { table, fields, unique: opts.unique === true }); },
  }, DataTypes);
  for (const model of models) {
    const columns = tables.get(model.tableName), attrs = model.rawAttributes;
    assert.deepEqual(Object.keys(attrs).sort(), Object.keys(columns).sort());
    for (const [key, column] of Object.entries(columns)) {
      const columnType = typeof column.type === 'function' ? column.type() : column.type;
      assert.equal(attrs[key].type.toString(), sequelize.normalizeDataType(columnType).toString(), model.name + '.' + key);
      assert.equal(attrs[key].allowNull, column.allowNull, model.name + '.' + key);
      if (column.references) { assert.deepEqual(attrs[key].references, column.references); assert.equal(attrs[key].onDelete, 'RESTRICT'); }
    }
    for (const index of model.options.indexes) assert.deepEqual(indexes.get(index.name), { table: model.tableName, fields: index.fields, unique: index.unique === true });
  }
  assert.equal(models[1].primaryKeyAttribute, 'appointment_id');
  assert.deepEqual(indexes.get('avc_visit_purpose_revision_window').fields, ['visit_id', 'purpose', 'communication_revision', 'window_sha256']);
  const communication = models[2].build({ status: 'bad' });
  await assert.rejects(communication.validate(), error => error.errors.some(item => item.path === 'status'));
  await sequelize.close();
});
test('ordinary migration rollback refuses every kind of nonempty history and drops nothing', async () => {
  for (const populated of ['AppointmentVisitCommunications', 'AppointmentVisitMembers', 'AppointmentVisits']) {
    const drops = [];
    await assert.rejects(migration.down({ sequelize: { async query(sql) { return [[{ count: sql.includes('`' + populated + '`') ? 1 : 0 }]]; } },
      async dropTable(name) { drops.push(name); } }), /durable history/);
    assert.deepEqual(drops, []);
  }
  const drops = [];
  await migration.down({ sequelize: { async query() { return [[{ count: 0 }]]; } }, async dropTable(name) { drops.push(name); } });
  assert.deepEqual(drops, ['AppointmentVisitCommunications', 'AppointmentVisitMembers', 'AppointmentVisits']);
});
test('combined frozen steps change revision when a later professional/room/step changes without top-level changes', () => {
  const id = randomUUID(), original = combinedAppointment(), base = snapshot(original, id);
  assert.equal(base.snapshot.reservations[0].booking.steps.length, 2);
  for (const mutate of [row => { row.import_metadata.booking.phases[1].doctor_ids = [52]; },
    row => { row.import_metadata.booking.phases[1].installation_id = 77; },
    row => { row.import_metadata.booking.profile.phases[1].key = 'other_care'; row.import_metadata.booking.phases[1].key = 'other_care'; },
    row => { row.import_metadata.additional_staff = { version: 1, ids: [53], start_at: row.inicio, end_at: row.fin }; }]) {
    const changed = structuredClone(original); mutate(changed);
    for (const field of ['doctor_id', 'instalacion_id', 'tratamiento_id', 'inicio', 'fin']) assert.equal(changed[field], original[field]);
    assert.notEqual(snapshot(changed, id).snapshot_sha256, base.snapshot_sha256);
  }
});
test('phase snapshot key reordering/names/warnings/turnaround do not change communication revision', () => {
  const id = randomUUID(), original = combinedAppointment(), base = snapshot(original, id), changed = structuredClone(original);
  changed.import_metadata.booking.warnings = [{ fixture: true }];
  for (const phase of changed.import_metadata.booking.phases) {
    phase.doctor_names = ['Fixture staff name']; phase.installation_name = 'Fixture room name'; phase.label = 'Fixture label';
    phase.turnaround_minutes = 30;
    phase.staff_attention = phase.staff_attention.map(policy => Object.fromEntries(Object.entries(policy).reverse()));
  }
  assert.equal(snapshot(changed, id).snapshot_sha256, base.snapshot_sha256);
  assert(!JSON.stringify(base.snapshot).includes('Fixture staff name'));
});
test('present invalid frozen step evidence fails closed rather than reverting to top-level primary fields', () => {
  for (const mutate of [row => { row.import_metadata.booking.phases[1].doctor_ids = [99]; },
    row => { row.import_metadata.booking.capacity_fully_verified = false; },
    row => { row.import_metadata.booking.phases[1].start_at = row.inicio; },
    row => { row.import_metadata.booking.phases[1].staff_intervals = []; }]) {
    const row = combinedAppointment(); mutate(row);
    assert.throws(() => snapshot(row), { code: 'appointment_visit_booking_snapshot_unproven' });
  }
});
