#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const contract = require('../../lib/patientFollowUps.contract');
const { createPatientFollowUpService } = require('../../services/patientFollowUps.service');
const { createPatientFollowUpsController } = require('../../controllers/patientFollowUps.controller');

function matches(row, where = {}) {
  for (const key of Reflect.ownKeys(where)) {
    const value = where[key];
    if (key === Op.and) { if (!value.every((entry) => entry.val || matches(row, entry))) return false; continue; }
    if (key === Op.or) { if (!value.some((entry) => matches(row, entry))) return false; continue; }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      for (const comparison of Reflect.ownKeys(value)) {
        const operand = value[comparison];
        if (comparison === Op.in && !operand.includes(row[key])) return false;
        if (comparison === Op.notIn && operand.includes(row[key])) return false;
        if (comparison === Op.lt && !(row[key] != null && row[key] < operand)) return false;
        if (comparison === Op.gt && !(row[key] != null && row[key] > operand)) return false;
        if (comparison === Op.ne && row[key] === operand) return false;
        if (comparison === Op.gte && !(row[key] != null && row[key] >= operand)) return false;
        if (comparison === Op.lte && !(row[key] != null && row[key] <= operand)) return false;
      }
    } else if (row[key] !== value) return false;
  }
  return true;
}

function fixture() {
  const state = { rows: [], revisions: [], transactions: 0, queries: [],
    patients: [
      { id_paciente: 1, public_id: 'pac_one', clinica_id: 10, nombre: 'Ficticio', apellidos: 'Uno' },
      { id_paciente: 2, public_id: 'pac_two', clinica_id: 20, nombre: 'Ficticio', apellidos: 'Dos' },
      { id_paciente: 3, public_id: 'pac_shared', clinica_id: 20, nombre: 'Ficticio', apellidos: 'Compartido' },
    ],
    appointments: [
      { id_cita: 100, clinica_id: 10, paciente_id: 1, estado: 'pendiente', inicio: new Date('2026-10-01T08:00:00Z'), fin: new Date('2026-10-01T09:00:00Z'), titulo: 'Revisión ficticia', es_provisional: false },
      { id_cita: 101, clinica_id: 20, paciente_id: 1, estado: 'pendiente', es_provisional: false },
      { id_cita: 102, clinica_id: 10, paciente_id: 2, estado: 'pendiente', es_provisional: false },
      { id_cita: 103, clinica_id: 10, paciente_id: 1, estado: 'cancelada', es_provisional: false },
      { id_cita: 104, clinica_id: 10, paciente_id: 1, estado: 'pendiente', es_provisional: true },
      { id_cita: 105, clinica_id: 10, paciente_id: 1, estado: 'reprogramada', inicio: new Date('2026-11-01T08:00:00Z'), fin: new Date('2026-11-01T09:00:00Z'), es_provisional: false },
    ],
    treatments: [{ id_tratamiento: 5, nombre: 'Tratamiento ficticio', clinica_id: 10, origen: 'clinica' }, { id_tratamiento: 6, clinica_id: 20, origen: 'clinica' }],
  };
  const record = (value) => {
    const result = { ...value };
    Object.defineProperties(result, {
      toJSON: { value: () => ({ ...result }) },
      update: { value: async (patch) => Object.assign(result, patch) },
    });
    return result;
  };
  const db = {
    sequelize: {
      escape: (value) => `'${value}'`,
      transaction: async (fn) => { state.transactions++; return fn({ LOCK: { UPDATE: 'UPDATE' } }); },
    },
    PatientFollowUp: {
      findOne: async (options) => { state.queries.push(options); return state.rows.find((row) => matches(row, options.where)) || null; },
      findAll: async (options) => {
        state.queries.push(options);
        const rows = state.rows.filter((row) => matches(row, options.where));
        if (options.group) {
          return [...new Set(rows.map((row) => row.status))].map((status) => {
            const group = rows.filter((row) => row.status === status);
            const active = contract.ACTIVE_STATUSES.includes(status);
            return { status, total: group.length,
              overdue: group.filter((row) => active && row.contact_due_date && row.contact_due_date < '2026-09-07').length,
              due_next_30_days: group.filter((row) => active && row.contact_due_date >= '2026-09-07' && row.contact_due_date <= '2026-10-07').length,
              without_contact_date: group.filter((row) => active && !row.contact_due_date).length };
          });
        }
        return rows.sort(options.order?.[0]?.[0] === 'contact_due_date'
          ? (a, b) => a.contact_due_date.localeCompare(b.contact_due_date) || a.id - b.id
          : (a, b) => b.id - a.id).slice(0, options.limit);
      },
      create: async (values) => { const row = record({ id: state.rows.length + 1, ...values }); state.rows.push(row); return row; },
    },
    PatientFollowUpRevision: { create: async (row) => state.revisions.push(row) },
    Paciente: {
      findOne: async ({ where }) => state.patients.find((row) => matches(row, where)),
      findAll: async ({ where }) => state.patients.filter((row) => matches(row, where)),
    },
    PacienteClinica: { findOne: async ({ where }) => where.paciente_id === 3 && where.clinica_id === 10 ? { id: 1 } : null },
    CitaPaciente: {
      findOne: async ({ where }) => state.appointments.find((row) => matches(row, where)),
      findAll: async ({ where, limit }) => state.appointments.filter((row) => matches(row, where)).sort((a, b) => b.id_cita - a.id_cita).slice(0, limit),
    },
    Tratamiento: {
      findOne: async ({ where }) => state.treatments.find((row) => matches(row, where)),
      findAll: async ({ where }) => state.treatments.filter((row) => matches(row, where)),
    },
    Clinica: { findOne: async () => null },
    AppointmentClinicalReport: { findOne: async ({ where }) => where.appointment_id === 100 ? { id: 80 } : null },
  };
  const service = createPatientFollowUpService({ db, now: () => new Date('2026-09-06T23:30:00Z') });
  const create = (payload = {}, rest = {}) => service.create({ clinicId: 10, patientIdentifier: 'pac_one', actorId: 7,
    payload: { operational_reason: 'Revisión de prueba', ...payload }, ...rest });
  return { db, state, service, create };
}

test('date-only validation, calendar month clipping and Madrid day respect DST', () => {
  assert.equal(contract.previousMonth('2026-03-31'), '2026-02-28');
  assert.equal(contract.previousMonth('2024-03-31'), '2024-02-29');
  assert.equal(contract.previousMonth('2026-01-31'), '2025-12-31');
  assert.equal(contract.madridToday(new Date('2026-09-06T23:30:00Z')), '2026-09-07');
  assert.equal(contract.madridToday(new Date('2026-03-29T00:30:00Z')), '2026-03-29');
  for (const value of ['2026-02-29', '2026-04-31', '2026-01-01T10:00:00Z', '1800-01-01']) {
    assert.throws(() => contract.dateOnly(value, 'date'), { code: 'follow_up_invalid_date' });
  }
  for (const value of ['10abc', '1.5', -1, '01', '9007199254740993']) assert.throws(() => contract.positiveInteger(value));
});

test('manual creation, redaction, scoped source and revisions without appointment creation', async () => {
  const { create, state } = fixture();
  const result = await create({ clinical_target_date: '2027-03-31', treatment_id: 5 });
  assert.equal(result.created, true);
  assert.equal(result.item.contact_due_date, '2027-02-28');
  assert.equal(result.item.treatment_name, 'Tratamiento ficticio');
  assert.equal(result.item.clinical_notes, null);
  assert.equal(result.item.clinical_notes_redacted, true);
  assert.equal(state.appointments.length, 6);
  assert.equal(state.revisions.length, 1);
  assert.equal(state.revisions[0].snapshot.operational_reason, 'Revisión de prueba');
  await assert.rejects(create({ clinical_notes: 'Private' }), { statusCode: 403 });
  await assert.rejects(create({ treatment_id: 6 }), { code: 'follow_up_treatment_not_found' });
});

test('source date of imported alerts is contact date, never subtracted another month', async () => {
  const { create } = fixture();
  const result = await create({}, { importedSource: { kind: 'cliniccloud_alert', namespace: 'group:100', reference: 'alert:200', date: '2026-10-01', date_semantics: 'contact_due' } });
  assert.equal(result.item.contact_due_date, '2026-10-01');
  assert.equal(result.item.clinical_target_date, null);
  assert.equal(result.item.source_date_semantics, 'contact_due');
  const unknown = await create({}, { importedSource: { kind: 'cliniccloud_alert', namespace: 'group:100', reference: 'alert:201', date: '2026-10-01', date_semantics: 'unknown' } });
  assert.equal(unknown.item.contact_due_date, null);
  await assert.rejects(create({ source_kind: 'cliniccloud_alert' }), { code: 'follow_up_source_reserved' });
  await assert.rejects(create({ source_reference: 'forged' }), { code: 'follow_up_source_reserved' });
});

test('idempotent report creation, changed payload conflict and patient/clinic scope', async () => {
  const { create, state } = fixture();
  const payload = { source_appointment_id: 100, clinical_target_date: '2027-03-31' };
  const first = await create(payload);
  const second = await create(payload);
  assert.equal(second.created, false);
  assert.equal(first.item.id, second.item.id);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].source_report_id, 80);
  await assert.rejects(create({ ...payload, clinical_target_date: '2027-04-01' }), (error) => error.code === 'follow_up_already_exists' && error.details.existing_id === first.item.id);
  await assert.rejects(create({ source_appointment_id: 101 }), { code: 'follow_up_appointment_not_found' });
  await assert.rejects(create({}, { patientIdentifier: 'pac_two' }), { statusCode: 404 });
  const shared = await create({}, { patientIdentifier: 'pac_shared' });
  assert.equal(shared.item.patient_id, 3);
});

test('versioned mutations, explicit appointment link, re-open and private notes', async () => {
  const { create, service, state } = fixture();
  const { item } = await create();
  const update = (payload, extra = {}) => service.update({ clinicId: 10, id: item.id, actorId: 7, payload: { expected_version: 1, ...payload }, ...extra });
  await assert.rejects(update({ status: 'scheduled' }), { code: 'follow_up_appointment_required' });
  for (const id of [101, 102]) await assert.rejects(update({ status: 'scheduled', linked_appointment_id: id }), { code: 'follow_up_appointment_not_found' });
  for (const id of [103, 104]) await assert.rejects(update({ status: 'scheduled', linked_appointment_id: id }), { code: 'follow_up_appointment_inactive' });
  const scheduled = await update({ status: 'scheduled', linked_appointment_id: 100 });
  assert.equal(scheduled.item.version, 2);
  assert.equal(scheduled.item.linked_appointment_id, 100);
  await assert.rejects(update({ status: 'closed' }), { code: 'follow_up_version_conflict' });
  const reopened = await update({ expected_version: 2, status: 'pending' });
  assert.equal(reopened.item.linked_appointment_id, null);
  const privateResult = await update({ expected_version: 3, clinical_notes: 'Private fixture' }, { includeClinical: true });
  assert.equal(privateResult.item.clinical_notes, 'Private fixture');
  const hidden = await service.get({ id: item.id, clinicId: 10 });
  assert.equal(hidden.item.clinical_notes, null);
  assert.equal(state.revisions.length, 4);
  assert.ok(state.queries.some((query) => query.lock === 'UPDATE'));
  await assert.rejects(update({ expected_version: 4, clinic_id: 20 }), { code: 'follow_up_immutable_source' });
});

test('bounded scoped pagination, server summary shares filters but not cursor', async () => {
  const { create, service, state } = fixture();
  await create({ contact_due_date: '2026-09-01' });
  await create({ contact_due_date: '2026-09-08', status: 'contacted' });
  await create({ contact_due_date: '2026-09-09', status: 'closed' });
  await create({});
  const first = await service.list({ clinicId: 10, patientIdentifier: 'pac_one', query: { status: 'pending,contacted', limit: 1 } });
  assert.equal(first.items.length, 1);
  assert.equal(first.summary.total, 3);
  assert.equal(first.summary.closed, 0);
  assert.equal(first.summary.overdue, 1);
  assert.equal(first.summary.due_next_30_days, 1);
  assert.equal(first.summary.without_contact_date, 1);
  assert.equal(first.as_of_date, '2026-09-07');
  const second = await service.list({ clinicId: 10, patientIdentifier: 'pac_one', query: { status: 'contacted,pending', limit: 1, cursor: first.next_cursor } });
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.deepEqual(first.summary, second.summary);
  await assert.rejects(service.list({ clinicId: 10, patientIdentifier: 'pac_one', query: { status: 'closed', cursor: first.next_cursor } }), { code: 'follow_up_invalid_cursor' });
  await assert.rejects(service.list({ clinicId: 10, query: { limit: 101 } }), { statusCode: 400 });
  const query = state.queries.find((entry) => entry.group);
  assert.match(query.where[Op.and][0].val, /PacienteClinicas/);
  assert.match(query.where[Op.and][0].val, /clinica_id = 10/);
});

test('appointment candidates bound patient, clinic, future active and reject unrelated cursor', async () => {
  const { create, service } = fixture();
  const { item } = await create();
  const first = await service.appointmentCandidates({ id: item.id, clinicId: 10, query: { limit: 1 } });
  assert.equal(first.items[0].id, 105);
  const second = await service.appointmentCandidates({ id: item.id, clinicId: 10, query: { limit: 1, cursor: first.next_cursor } });
  assert.equal(second.items[0].id, 100);
  assert.equal(second.next_cursor, null);
  await assert.rejects(service.appointmentCandidates({ id: item.id, clinicId: 20 }), { statusCode: 404 });
  await assert.rejects(service.appointmentCandidates({ id: item.id, clinicId: 10, query: { limit: 51 } }), { statusCode: 400 });
});

test('clinic panel window is calculated in backend, earliest due first and date-keyset bounded', async () => {
  const { create, service } = fixture();
  await create({ contact_due_date: '2026-09-08' });
  await create({ contact_due_date: '2026-09-01' });
  await create({ contact_due_date: '2026-09-01' });
  await create({ contact_due_date: '2026-10-08' });
  await create({});
  const first = await service.list({ clinicId: 10, query: { window: 'next_30_days', status: 'pending,contacted', limit: 1 } });
  assert.equal(first.items[0].contact_due_date, '2026-09-01');
  assert.equal(first.summary.total, 3);
  assert.equal(first.summary.overdue, 2);
  const second = await service.list({ clinicId: 10, query: { window: 'next_30_days', status: 'pending,contacted', limit: 1, cursor: first.next_cursor } });
  assert.equal(second.items[0].contact_due_date, '2026-09-01');
  assert.notEqual(first.items[0].id, second.items[0].id);
  const third = await service.list({ clinicId: 10, query: { window: 'next_30_days', status: 'pending,contacted', limit: 1, cursor: second.next_cursor } });
  assert.equal(third.items[0].contact_due_date, '2026-09-08');
  assert.equal(third.next_cursor, null);
  const undated = await service.list({ clinicId: 10, query: { window: 'undated', status: 'pending,contacted' } });
  assert.equal(undated.summary.total, 1);
  assert.equal(undated.items[0].contact_due_date, null);
  await assert.rejects(service.list({ clinicId: 10, query: { window: 'undated', cursor: first.next_cursor } }), { code: 'follow_up_invalid_cursor' });
});

test('report context reopens same source and changed linked appointment is a live projection', async () => {
  const { create, service, state } = fixture();
  assert.equal((await service.getForSourceAppointment({ clinicId: 10, appointmentId: 100 })).item, null);
  const { item } = await create({ source_appointment_id: 100, status: 'scheduled', linked_appointment_id: 105 });
  assert.equal((await service.getForSourceAppointment({ clinicId: 10, appointmentId: 100 })).item.id, item.id);
  await assert.rejects(service.getForSourceAppointment({ clinicId: 20, appointmentId: 100 }), { statusCode: 404 });
  const linked = state.appointments.find(row => row.id_cita === 105);
  linked.estado = 'cancelada';
  const cancelled = await service.get({ clinicId: 10, id: item.id });
  assert.equal(cancelled.item.linked_appointment_needs_review, true);
  linked.estado = 'reprogramada';
  linked.inicio = new Date('2026-12-15T10:00:00Z');
  const moved = await service.get({ clinicId: 10, id: item.id });
  assert.equal(moved.item.linked_appointment_needs_review, false);
  assert.equal(moved.item.linked_appointment_start.toISOString(), '2026-12-15T10:00:00.000Z');
  linked.estado = 'completada';
  assert.equal((await service.get({ clinicId: 10, id: item.id })).item.linked_appointment_completed, true);
});

async function call(handler, req) {
  let result;
  const res = { set: () => res, status: () => res, json: (value) => { result = value; } };
  await handler(req, res, (error) => { throw error; });
  return result;
}

test('HTTP controller enforces sensitive scope and report permissions before any data query', async () => {
  const checks = [];
  let listCalls = 0;
  const followUps = { ...contract, list: async () => { listCalls++; return { items: [] }; }, create: async () => ({ item: {}, created: true }) };
  const controller = createPatientFollowUpsController({ followUps, canAccess: async (ctx) => { checks.push(ctx); return ctx.featureKey !== 'patients.sensitive.view'; } });
  const req = { method: 'GET', userData: { userId: 7 }, query: { clinic_id: '10' } };
  await assert.rejects(call(controller.list, req), { statusCode: 403 });
  assert.equal(listCalls, 0);
  assert.ok(checks.some((entry) => entry.featureKey === 'appointments.view'));
  const reportController = createPatientFollowUpsController({ followUps, canAccess: async ({ featureKey }) => featureKey !== 'clinical.reports.manage' });
  await assert.rejects(call(reportController.create, { ...req, method: 'POST', body: { clinic_id: 10, patient_id: 1, source_appointment_id: 100 } }), { statusCode: 403 });
});

test('new domain has no jobs/messages and routes require auth, migration refuses deleting clinical history', async () => {
  const serviceSource = fs.readFileSync(path.resolve(__dirname, '../../services/patientFollowUps.service.js'), 'utf8');
  assert.doesNotMatch(serviceSource, /jobScheduler|JobRequest|whatsappService|sendMessage|CitaPaciente\.(create|update|destroy)/);
  const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/patientFollowUps.routes.js'), 'utf8');
  assert.match(routes, /router\.use\(authMiddleware\)/);
  assert.doesNotMatch(routes, /router\.delete/);
  const migration = require('../../../migrations/20260906230000-create-patient-follow-ups');
  let dropped = false;
  await assert.rejects(migration.down({ sequelize: { query: async () => [[{ count: 1 }]] }, dropTable: async () => { dropped = true; } }), /contiene historia/);
  assert.equal(dropped, false);
});
