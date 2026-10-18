'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('sequelize');
const C = require('../../lib/patient-mobile-verification');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

function fixture() {
  const patient = { id_paciente: 101, clinica_id: 72, telefono_movil: '34600000001' };
  const request = { id: 10, patient_id: 101, clinic_id: 72, actor_user_id: 15,
    event_type: C.REQUEST, source: 'privacy_profile_review',
    metadata: { schema_version: C.SCHEMA, phone: patient.telefono_movil, document_id: 50,
      snapshot_hash: 'TESTONLY-source', delivery_enabled: true, reply_token: 'TESTONLY-private' } };
  const transitions = [], locks = [], writes = [], emitted = [];
  const notification = { isRead: false, data: { request_event_id: request.id, requiresAcknowledgement: true },
    async update(patch, options) { assert.equal(options.transaction, tx); Object.assign(this, patch); } };
  const tx = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, afterCommit: fn => emitted.push(fn) };
  const f = { transactions: 0, eventFailure: false };
  const db = { Sequelize: S, sequelize: { transaction: async (options, work) => {
    assert.equal(options.isolationLevel, 'READ COMMITTED'); f.transactions++;
    const before = structuredClone(patient), history = transitions.length;
    const notificationBefore = { isRead: notification.isRead, data: structuredClone(notification.data) };
    try { return await work(tx); }
    catch (error) { Object.assign(patient, before); transitions.length = history; Object.assign(notification, notificationBefore); throw error; }
  } },
  Clinica: { findByPk: async (id, options) => { locks.push(['clinic', id, options.transaction]); return { id_clinica: id }; } },
  Paciente: { findByPk: async (_id, options) => { if (options?.lock) locks.push(['patient', patient.id_paciente, options.transaction]); return patient; } },
  PacienteClinica: { findOne: async () => null },
  PatientConsentDocument: { findByPk: async () => ({ paciente_id: 101, clinica_id: 72,
    status: 'signed', snapshot_hash: request.metadata.snapshot_hash }) },
  PatientOperationalEvent: { findOne: async () => request, findAll: async () => transitions,
    create: async (values, options) => {
      assert.equal(options.transaction, tx);
      if (f.eventFailure) throw Error('TESTONLY_AUDIT_FAILURE');
      const row = { ...values, id: request.id + transitions.length + 1 };
      transitions.push(row); return row;
    } },
  Notification: { findAll: async () => [notification] },
  FlowExecutionV2: { findOne: async () => null } };
  const service = loadSource('patientMobileVerification.service', {
    'node:crypto': require('node:crypto'), './patientPrivacyProfile.service': { groupClinicIds: async () => [73, 72] },
    './notificationsRealtime.service': { emitNotificationUpdated: value => writes.push(value) },
  }, {});
  const runtime = service.createRuntime({ db });
  const change = (phone, extra = {}) => service.withPatientMobileChange({ db, patientId: patient.id_paciente,
    clinicId: 72, previousPhone: patient.telefono_movil, nextPhone: phone, actorId: 16, ...extra },
  async transaction => { writes.push({ phone, transaction }); patient.telefono_movil = phone; return 'saved'; });
  return Object.assign(f, { patient, request, transitions, locks, writes, emitted, notification, tx, db, service, runtime, change });
}

test('generic mobile change retires previous verification atomically without requesting another message', async () => {
  const f = fixture();
  assert.equal(await f.change('34600000002'), 'saved');
  assert.equal(f.transactions, 1); assert.equal(f.patient.telefono_movil, '34600000002');
  assert.equal(f.transitions.length, 1); assert.equal(f.transitions[0].event_type, C.RESOLVED);
  const result = await f.runtime.state(f.request);
  assert.equal(result.current, false); assert.equal(result.reason, 'phone_changed'); assert.equal(result.actor_user_id, 16);
  assert.equal(f.request.metadata.phone, '34600000001'); assert.equal(f.request.metadata.delivery_enabled, true);
  assert.equal(f.notification.isRead, true); assert.equal(f.notification.data.resolution, 'superseded');
  assert.deepEqual(f.locks.map(([type, id]) => [type, id]), [['clinic', 72], ['clinic', 73], ['patient', 101]]);
  assert(f.locks.every(([, , tx]) => tx === f.tx)); assert.equal(f.writes[0].transaction, f.tx);
  assert.equal(f.emitted.length, 1, 'realtime notification update is deferred until commit');
});

test('A to B to A through the generic editor cannot revive the old request', async () => {
  const f = fixture();
  await f.change('34600000002'); await f.change('34600000001');
  assert.equal(f.transactions, 2); assert.equal(f.transitions.length, 1, 'no duplicate retirement or new request');
  assert.equal((await f.runtime.state(f.request)).current, false);
  assert.equal(await f.runtime.current(f.request, f.patient), false);
});

test('equivalent-phone and unrelated edits do not invalidate or open a new transaction', async () => {
  const f = fixture(); await f.change('+34 600 000 001');
  assert.equal(f.transactions, 0); assert.equal(f.transitions.length, 0); assert.equal(f.notification.isRead, false);
  assert.equal(f.writes[0].transaction, undefined);
});

test('an audit failure rolls back the phone and leaves the verification/review task untouched', async () => {
  const f = fixture(); f.eventFailure = true;
  await assert.rejects(f.change('34600000002'), /TESTONLY_AUDIT_FAILURE/);
  assert.equal(f.patient.telefono_movil, '34600000001'); assert.equal(f.transitions.length, 0);
  assert.equal(f.notification.isRead, false); assert.equal(f.notification.data.requiresAcknowledgement, true);
});

test('a concurrent mobile/clinic change and permission revocation prevent any save or invalidation', async () => {
  for (const patch of [{ telefono_movil: '34600000009' }, { clinica_id: 73 }]) {
    const f = fixture(); Object.assign(f.patient, patch);
    await assert.rejects(f.change('34600000002', { previousPhone: '34600000001' }), /mobile_verification_changed/);
    assert.equal(f.writes.length, 0); assert.equal(f.transitions.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.change('34600000002', { authorizeCurrent: async () => { throw Error('TESTONLY_ACCESS_DENIED'); } }), /TESTONLY_ACCESS_DENIED/);
  assert.equal(f.writes.length, 0); assert.equal(f.transitions.length, 0);
});

test('recoverable lock failures return a conflict without exposing database details', async () => {
  for (const code of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']) {
    const f = fixture();
    f.db.sequelize.transaction = async () => { throw Object.assign(Error('TESTONLY-private-sql'), { original: { code } }); };
    await assert.rejects(f.change('34600000002'), error => error.code === 'mobile_verification_changed'
      && error.statusCode === 409 && !error.message.includes('TESTONLY-private-sql'));
    assert.equal(f.writes.length, 0); assert.equal(f.transitions.length, 0);
  }
});
