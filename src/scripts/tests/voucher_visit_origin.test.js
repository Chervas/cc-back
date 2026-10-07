'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const origin = require('../../lib/voucher-booking-origin');
const replay = require('../../lib/voucher-booking-replay');
const r = require('../../lib/appointment-visit-runtime-contract');
const v = require('../../lib/appointment-visit-communication');
const { combinedAppointment, NOW } = require('./helpers/appointment-visit-fixture');
const f = require('./helpers/appointment-visit-runtime-fixture');
function fixture() {
  const row = combinedAppointment(), voucher = { id: 5, public_id: randomUUID(), clinic_id: 66, patient_id: 8,
    treatment_id: row.tratamiento_id, status: 'active', available_units: 5, source_system: 'cliniccloud', source_reference: 'original',
    budget_id: null, budget_line_key: null };
  row.voucher_id = voucher.id;
  const slotSha = require('../../lib/booking-plan-receipt').bookingPlanHash(row.import_metadata.booking.profile, {
    start_at: row.inicio, end_at: row.fin, phases: row.import_metadata.booking.phases,
    capacity_fully_verified: true, attention_requirements_pending: [], warnings: [],
  });
  const plan = { has_conflicts: false, rawVoucher: voucher, treatment: { nombre: 'Ficticio' }, physicalTemplate: row.import_metadata.booking.profile,
    bookingProfile: row.import_metadata.booking.profile, configuration: { count: 1, interval_days: 7, duration_minutes: 45 },
    appointments: [{ sequence: 1, start_at: row.inicio, end_at: row.fin, phases: row.import_metadata.booking.phases,
      booking_plan_sha256: slotSha }] };
  const metadata = replay.preparedMetadata(plan, 7), events = [{ id: '100', source: replay.SOURCE,
    event_type: replay.eventType('prepared', metadata.request_key), actor_user_id: 7, clinic_id: 66, patient_id: 8, metadata }];
  const transaction = { options: { isolationLevel: 'READ COMMITTED' }, LOCK: { UPDATE: 'UPDATE' }, finished: undefined };
  const queries = [], db = { PatientVoucher: { findByPk: async () => voucher }, PatientOperationalEvent: {
    findAll: async options => { queries.push(options); return events.filter(row => row.event_type === options.where.event_type); } } };
  const reader = origin.createVoucherBookingOriginReader({ db }), args = { voucherId: voucher.id, parentRequestKey: metadata.request_key,
    parentRequestSha256: metadata.request_sha256, actorId: 7, sequence: 1, slotPlanSha256: slotSha, transaction };
  return { row, voucher, metadata, events, transaction, queries, db, reader, args };
}
test('ordinary native birth hash bytes remain unchanged and unproved voucher/single-step eligibility remains closed', () => {
  assert.equal(r.birthRequestHash({ clinicId: 66, patientId: 8, plan: f.plan() }), '10ae5af58582ccb351c2b55d6ac84196aa5f87a8fd9ba0015736ade9fde52b40');
  const row = combinedAppointment(); row.voucher_id = 5;
  assert.throws(() => r.assertBirthEligibility(row, NOW), /birth_ineligible/);
  row.voucher_id = null; row.import_metadata.booking.phases.pop(); row.import_metadata.booking.profile.phases.pop(); row.fin = '2030-01-07T10:15:00.000Z';
  assert.throws(() => r.assertBirthEligibility(row, NOW), /birth_ineligible/);
});
test('native prepared ledger produces opaque proof bound to factory, transaction, actor, slot and voucher scope', async () => {
  const x = fixture(), proof = await x.reader.prepare(x.args);
  const saved = origin.proofOrigin(proof, { transaction: x.transaction, appointment: x.row, db: x.db });
  assert.equal(saved.purchase_references.source_system, 'cliniccloud');
  assert.equal(saved.prepared_event_id, '100');
  assert.equal(x.queries[0].limit, 2); assert.equal(x.queries[0].where.event_type, replay.eventType('prepared', x.metadata.request_key));
  for (const forged of [structuredClone(proof), saved, { schema: origin.SCHEMA }]) {
    assert.throws(() => origin.proofOrigin(forged, { transaction: x.transaction }), /server_origin_required/);
  }
  assert.throws(() => origin.createVoucherBookingOriginReader({ db: x.db }).ownProof(proof, x.transaction), /server_origin_required/);
  assert.throws(() => origin.proofOrigin(proof, { transaction: { ...x.transaction } }), /server_origin_required/);
  assert.throws(() => origin.proofOrigin(proof, { transaction: x.transaction, appointment: { ...x.row, voucher_id: 6 } }), /scope_changed/);
  x.transaction.finished = 'commit'; assert.throws(() => origin.proofOrigin(proof, { transaction: x.transaction }), /server_origin_required/);
});
test('only a verified new origin permits single-step v4; source/history/HOLD/partial capacity never become an exception', async () => {
  const x = fixture(), proof = await x.reader.prepare(x.args), single = structuredClone(x.row);
  single.import_metadata.booking.profile.phases.pop(); single.import_metadata.booking.phases.pop(); single.fin = '2030-01-07T10:15:00.000Z';
  const opts = { voucherOriginProof: proof, transaction: x.transaction };
  r.assertBirthEligibility(single, NOW, opts);
  for (const change of [row => { row.source_system = 'cliniccloud'; }, row => { row.import_metadata.historical_registration = true; },
    row => { row.import_metadata.automation_policy = 'hold'; }, row => { row.import_metadata.booking.capacity_fully_verified = false; },
    row => { row.import_metadata.booking.profile.version = 3; }, row => { row.import_metadata.notification_suppression = { details: true }; }]) {
    const bad = structuredClone(single); change(bad); assert.throws(() => r.assertBirthEligibility(bad, NOW, opts));
  }
});
test('deterministic private child UUID distinguishes sequence/full slot hash and voucher hash seals origin separately from ordinary plan', async () => {
  const x = fixture(), proof = await x.reader.prepare(x.args), data = origin.proofOrigin(proof, { transaction: x.transaction });
  assert.match(origin.childRequestKey(data), /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(origin.childRequestKey(data), origin.childRequestKey(structuredClone(data)));
  assert.notEqual(origin.childRequestKey(data), origin.childRequestKey({ ...data, sequence: 2 }));
  assert.notEqual(origin.childRequestKey(data), origin.childRequestKey({ ...data, slot_booking_plan_sha256: 'b'.repeat(64) }));
  assert.notEqual(r.voucherBirthRequestHash({ clinicId: 66, patientId: 8, plan: f.plan(x.row), voucherOriginProof: proof, transaction: x.transaction }),
    r.birthRequestHash({ clinicId: 66, patientId: 8, plan: f.plan() }));
  const changedPolicy = f.plan(x.row); changedPolicy.booking.profile.phases[1].professionals.fallback_when = 'absence_only';
  assert.throws(() => r.voucherBirthRequestHash({ clinicId: 66, patientId: 8, plan: changedPolicy,
    voucherOriginProof: proof, transaction: x.transaction }), { code: 'booking_plan_changed' });
});
test('prepared source reread rejects changed purchase references, actor, hash, slot, program and duplicate/missing ledger', async () => {
  for (const mutate of [x => { x.args.actorId = 8; }, x => { x.args.parentRequestSha256 = 'b'.repeat(64); },
    x => { x.args.sequence = 2; }, x => { x.args.slotPlanSha256 = 'b'.repeat(64); }, x => { x.voucher.source_reference = 'changed'; },
    x => { x.voucher.source_system = 'treatment_program'; }, x => { x.events.push(x.events[0]); }, x => { x.events.length = 0; }]) {
    const x = fixture(); mutate(x); await assert.rejects(x.reader.prepare(x.args));
  }
});
test('current consumer requires committed aggregate and native child binding, but valid mutation does not need birth time equality', async () => {
  const x = fixture(), proof = await x.reader.prepare(x.args), data = origin.proofOrigin(proof, { transaction: x.transaction });
  const requestKey = origin.childRequestKey(data), sha = r.voucherBirthRequestHash({ clinicId: 66, patientId: 8,
    plan: f.plan(x.row), voucherOriginProof: proof, transaction: x.transaction });
  const visit = { id: randomUUID(), clinic_id: 66, patient_id: 8, owner_appointment_id: x.row.id_cita,
    runtime_enrollment: { origin: data, actor_id: 7, birth_request_key: requestKey, birth_request_sha256: sha } };
  x.db.AppointmentVisitBirthRequest = { findOne: async () => ({ appointment_id: x.row.id_cita, visit_id: visit.id, patient_id: 8, actor_id: 7, request_sha256: sha }) };
  const requestModel = x.db.AppointmentVisitBirthRequest; delete x.db.AppointmentVisitBirthRequest;
  await assert.rejects(x.reader.forVisit({ visit, appointment: x.row, transaction: x.transaction }), /guard_unavailable/);
  x.db.AppointmentVisitBirthRequest = requestModel;
  await assert.rejects(x.reader.forVisit({ visit, appointment: x.row, transaction: x.transaction }), /ledger_invalid/);
  const receipt = replay.receiptForAppointments([x.row]);
  x.events.push({ id: '101', source: replay.SOURCE, event_type: replay.eventType('committed', x.metadata.request_key), actor_user_id: 7,
    clinic_id: 66, patient_id: 8, metadata: replay.committedMetadata(x.metadata, receipt) });
  const moved = { ...x.row, inicio: '2030-01-08T10:00:00Z', fin: '2030-01-08T10:45:00Z' };
  const consumer = await x.reader.forVisit({ visit, appointment: moved, transaction: x.transaction });
  assert.equal(origin.proofOrigin(consumer, { transaction: x.transaction, appointment: moved }).sequence, 1);
  x.voucher.status = 'cancelled'; x.voucher.available_units = 0; x.voucher.source_reference = 'not reread commercial policy';
  await x.reader.forVisit({ visit, appointment: moved, transaction: x.transaction });
  x.db.AppointmentVisitBirthRequest.findOne = async () => ({ appointment_id: 999, visit_id: visit.id, patient_id: 8, actor_id: 7, request_sha256: sha });
  await assert.rejects(x.reader.forVisit({ visit, appointment: moved, transaction: x.transaction }), /receipt_invalid/);
});
test('origin shape is strict and frozen references do not claim a commercial purchase revision', () => {
  const bad = { schema: origin.SCHEMA }; assert.throws(() => origin.normalizeOrigin(bad));
  assert.throws(() => origin.proofOrigin({ voucher_origin_verified: true }));
  assert.equal(origin.SCHEMA, 'appointment-visit-voucher-origin/1');
});
