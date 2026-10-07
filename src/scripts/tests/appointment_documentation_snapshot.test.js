'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { digest, exactApprovedRevision, sealSnapshot, readSnapshot } = require('../../lib/appointment-documentation-snapshot');
const Sequelize = require('sequelize');
const { createTreatmentDocumentationService } = require('../../services/treatmentDocumentation.service');
const approved = () => ({ id: 20, version: 2, clinic_id: 100, kind: 'protocol', status: 'approved', title: 'Protocolo ficticio',
  content: 'Texto clínico ficticio, no instrucciones reales.', source: 'Fuente OWNED ficticia', approved_by: 7,
  approved_at: '2030-01-07T10:00:00Z', treatment_ids: [11] });
const fixture = () => {
  const snapshot = sealSnapshot({ appointment_id: 1, clinic_id: 100, patient_id: 2, schedule_start: '2030-01-07T10:00:00Z',
    started_at: '2030-01-07T10:05:00Z', treatment_ids: [11], revisions: [{ id: 20, version: 2, snapshot_sha256: digest(approved()) }], draft_count: 0 });
  const appointment = { id_cita: 1, clinica_id: 100, paciente_id: 2, care_schedule_start: snapshot.schedule_start, care_started_at: snapshot.started_at, care_started_by: 7 };
  const careEvent = { id: 3, appointment_id: 1, clinic_id: 100, actor_id: 7, action: 'start', schedule_start: snapshot.schedule_start, created_at: snapshot.started_at };
  const operationalEvent = { patient_id: 2, clinic_id: 100, actor_user_id: 7, event_type: 'appointment_care_changed', source: 'agenda',
    occurred_at: snapshot.started_at, metadata: { appointment_id: 1, action: 'start', care_event_id: 3 } };
  return { snapshot, context: { appointment, careEvent, operationalEvent } };
};
test('exact approved revision hash, scope and explicit treatment membership; no mutable fallback', () => {
  const snapshot = approved(), ref = { id: 20, version: 2, snapshot_sha256: digest(snapshot) };
  const revision = { protocol_id: 20, version: 2, snapshot };
  assert.equal(exactApprovedRevision(revision, ref, 100, [11]).content, snapshot.content);
  for (const patch of [{ status: 'draft' }, { clinic_id: 200 }, { approved_by: null }, { source: '' }, { treatment_ids: [12] },
    { version: 3 }, { content: 'Texto cambiado posteriormente.' }]) {
    assert.equal(exactApprovedRevision({ ...revision, snapshot: { ...snapshot, ...patch } }, ref, 100, [11]), null);
  }
  assert.equal(exactApprovedRevision(null, ref, 100, [11]), null);
});
test('start snapshot is bound to exact append-only care event, patient, clinic and original start', () => {
  const { snapshot, context } = fixture();
  assert.deepEqual(readSnapshot(snapshot, context), snapshot);
  assert.equal(readSnapshot(undefined, context), null, 'legacy missing reference is not silently backfilled');
  for (const patch of [{ paciente_id: 9 }, { clinica_id: 200 }, { care_started_at: '2030-01-07T10:06:00Z' },
    { care_schedule_start: '2030-01-07T11:00:00Z' }, { care_started_by: 8 }]) {
    assert.throws(() => readSnapshot(snapshot, { ...context, appointment: { ...context.appointment, ...patch } }), { code: 'appointment_documentation_snapshot_changed' });
  }
  assert.throws(() => readSnapshot({ ...snapshot, draft_count: 4 }, context), { code: 'appointment_documentation_snapshot_changed' });
  assert.throws(() => readSnapshot({ ...snapshot, schema: 'unsupported' }, context), { code: 'appointment_documentation_snapshot_changed' });
  assert.throws(() => readSnapshot(snapshot, { ...context, careEvent: { ...context.careEvent, actor_id: 8 } }), { code: 'appointment_documentation_snapshot_changed' });
  assert.throws(() => readSnapshot(snapshot, { ...context, operationalEvent: { ...context.operationalEvent, source: 'client' } }), { code: 'appointment_documentation_snapshot_changed' });
});
test('empty protocol set is explicit absence, never clinical approval or an invented component', () => {
  const { snapshot } = fixture();
  const empty = sealSnapshot({ ...snapshot, treatment_ids: [11], revisions: [], draft_count: 2 });
  assert.deepEqual(empty.revisions, []); assert.deepEqual(empty.treatment_ids, [11]); assert.equal(empty.draft_count, 2);
  assert(!Object.hasOwn(empty, 'clinically_approved'));
  for (const patch of [{ treatment_ids: [11, 11] }, { treatment_ids: ['room:C7'] }, { draft_count: -1 },
    { revisions: [snapshot.revisions[0], snapshot.revisions[0]] }]) {
    assert.throws(() => sealSnapshot({ ...snapshot, ...patch }), { code: 'appointment_documentation_snapshot_invalid' });
  }
});

function serviceFixture() {
  const { snapshot, context } = fixture(), calls = [];
  const revisions = Array.from({ length: 24 }, (_, index) => {
    const s = { ...approved(), id: index + 20 };
    return { protocol_id: s.id, version: 2, snapshot: s };
  });
  const db = { Sequelize,
    Clinica: { findByPk: async () => ({ id_clinica: 100 }) },
    Tratamiento: { findAll: async options => { calls.push(options); return [{ id_tratamiento: 11, nombre: 'Técnica ficticia' }]; } },
    TreatmentProtocol: { findOne: async () => ({ id: 20 }), findAll: async options => { calls.push(options); return [
      ...revisions.map(row => ({ id: row.protocol_id, version: 2, status: 'approved' })), { id: 99, version: 1, status: 'draft' }]; } },
    TreatmentProtocolRevision: { findAll: async options => { calls.push(options); return revisions.filter(row =>
      options.where[Sequelize.Op.or].some(ref => ref.protocol_id === row.protocol_id && ref.version === row.version)); } },
    CitaPaciente: { findOne: async () => ({ ...context.appointment, tratamiento_id: 11 }) },
    Paciente: { findByPk: async () => ({ id_paciente: 2, clinica_id: 100 }) },
    PatientOperationalEvent: { findOne: async () => ({ ...context.operationalEvent,
      metadata: { ...context.operationalEvent.metadata, documentation_snapshot: snapshot } }) },
    AppointmentCareEvent: { findOne: async () => context.careEvent },
  };
  return { db, calls, revisions, snapshot, context, service: createTreatmentDocumentationService(db) };
}
test('actual capture method records ALL 24 approved references inside caller transaction, not contextual page5', async () => {
  const { service, calls, context } = serviceFixture(), transaction = { LOCK: { SHARE: 'SHARE' } };
  const a = { ...context.appointment, tratamiento_id: 11, inicio: context.appointment.care_schedule_start,
    import_metadata: { booking: { phases: [{ label: 'No puede convertirse en otro tratamiento', treatment_id: 999 }] } } };
  const frozen = await service.captureForStart({ appointment: a, transaction, now: context.appointment.care_started_at });
  assert.equal(frozen.revisions.length, 24); assert.equal(frozen.draft_count, 1); assert.deepEqual(frozen.treatment_ids, [11]);
  assert(!JSON.stringify(frozen).includes('Texto clínico'));
  assert(!Object.hasOwn(frozen, 'clinical_approval'));
  for (const query of calls) { assert.equal(query.transaction, transaction); assert(!Object.hasOwn(query, 'limit')); }
  await assert.rejects(service.captureForStart({ appointment: a }), { code: 'appointment_documentation_start_context_required' });
});
test('actual capture refuses missing exact approval revision, rather than borrowing mutable text or skipping it', async () => {
  const { service, revisions, context } = serviceFixture(); revisions[0].snapshot.status = 'draft';
  await assert.rejects(service.captureForStart({ appointment: { ...context.appointment, tratamiento_id: 11,
    inicio: context.appointment.care_schedule_start }, transaction: { LOCK: { SHARE: 'SHARE' } }, now: context.appointment.care_started_at }),
    { code: 'appointment_documentation_revision_unavailable' });
});
test('actual contextual reader serves frozen version without querying live catalogue; missing reference fails closed', async () => {
  const { service, db } = serviceFixture();
  db.TreatmentProtocol.findOne = db.TreatmentProtocol.findAll = db.Tratamiento.findAll = () => { throw Error('MUTABLE_CATALOG_FORBIDDEN'); };
  const context = await service.forAppointment({ clinicId: 100, appointmentId: 1 });
  assert.equal(context.context_source, 'appointment_start_snapshot'); assert.equal(context.persisted_for_appointment, true);
  assert.equal(context.items.length, 1); assert.equal(context.items[0].version, 2); assert.equal(context.total, 1);
  assert(!Object.hasOwn(context, 'patient_id')); assert(!Object.hasOwn(context.items[0], 'approved_by'));
  db.TreatmentProtocolRevision.findAll = async () => [];
  const missing = await service.forAppointment({ clinicId: 100, appointmentId: 1 });
  assert.deepEqual(missing.items, []); assert.equal(missing.unavailable_count, 1); assert.equal(missing.persisted_for_appointment, true);
});
