'use strict';

// A native NEW booking origin, not a claim that the commercial purchase has
// an immutable version. Only this SQL reader can issue the opaque proof;
// serialized enrollment/HTTP metadata never grants voucher eligibility.
const crypto = require('node:crypto');
const v = require('./appointment-visit-communication');
const replay = require('./voucher-booking-replay');
const SCHEMA = 'appointment-visit-voucher-origin/1';
const proofs = new WeakMap();
const fail = suffix => { throw Object.assign(Error('appointment_visit_runtime_voucher_' + suffix), {
  code: 'appointment_visit_runtime_voucher_' + suffix, statusCode: 409, retryable: false,
}); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const SHA = /^[0-9a-f]{64}$/;
const EVENT_ID = /^[1-9][0-9]{0,19}$/;
function purchaseReferences(voucher) {
  return { budget_id: voucher.budget_id == null ? null : String(voucher.budget_id),
    budget_line_key: voucher.budget_line_key || null, source_system: voucher.source_system || null,
    source_reference: voucher.source_reference || null };
}
function normalizeOrigin(value) {
  const row = v.object(value);
  if (!exact(row, ['schema', 'voucher_id', 'voucher_public_id', 'clinic_id', 'patient_id', 'actor_id',
    'prepared_event_id', 'parent_request_key', 'parent_request_sha256', 'sequence', 'slot_booking_plan_sha256', 'purchase_references'])
    || row.schema !== SCHEMA || !['voucher_id', 'clinic_id', 'patient_id', 'actor_id', 'sequence'].every(key => v.positiveId(row[key]))
    || row.sequence > 30 || !v.uuid(row.voucher_public_id) || !EVENT_ID.test(row.prepared_event_id)
    || !v.uuid(row.parent_request_key) || !SHA.test(row.parent_request_sha256) || !SHA.test(row.slot_booking_plan_sha256)
    || !exact(row.purchase_references, ['budget_id', 'budget_line_key', 'source_system', 'source_reference'])
    || row.purchase_references.budget_id != null && !EVENT_ID.test(row.purchase_references.budget_id)
    || ['budget_line_key', 'source_system', 'source_reference'].some(key => row.purchase_references[key] != null
      && (typeof row.purchase_references[key] !== 'string' || row.purchase_references[key].length > 120))) fail('origin_invalid');
  return v.clone(row);
}
function childRequestKey(origin) {
  const row = normalizeOrigin(origin);
  const bytes = crypto.createHash('sha256').update(v.canonical({ schema: SCHEMA,
    parent_request_key: row.parent_request_key, parent_request_sha256: row.parent_request_sha256,
    sequence: row.sequence, slot_booking_plan_sha256: row.slot_booking_plan_sha256 })).digest().subarray(0, 16);
  // RFC UUID variant with a private deterministic v8 payload. Not an HTTP key.
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function proofOrigin(token, { transaction, appointment = null, db = null } = {}) {
  const proof = proofs.get(token);
  if (!proof || proof.transaction !== transaction || transaction?.finished || db && proof.db !== db) fail('server_origin_required');
  if (appointment) {
    const row = v.plain(appointment), origin = proof.origin;
    if (Number(row.voucher_id) !== origin.voucher_id || Number(row.clinica_id) !== origin.clinic_id
      || Number(row.paciente_id) !== origin.patient_id || Number(row.tratamiento_id) !== proof.treatmentId
      || proof.appointmentId != null && Number(row.id_cita) !== proof.appointmentId) fail('scope_changed');
  }
  return v.clone(proof.origin);
}
function createVoucherBookingOriginReader({ db }) {
  const owner = Object.freeze({});
  const tx = transaction => {
    if (!transaction || transaction.finished || transaction.options?.isolationLevel !== 'READ COMMITTED'
      || !transaction.LOCK?.UPDATE || !db.PatientVoucher || !db.PatientOperationalEvent) fail('guard_unavailable');
    return transaction;
  };
  async function ledger(voucher, stage, requestKey, transaction) {
    const rows = await db.PatientOperationalEvent.findAll({ transaction, where: {
      patient_id: voucher.patient_id, clinic_id: voucher.clinic_id, source: replay.SOURCE,
      event_type: replay.eventType(stage, requestKey) }, order: [['occurred_at', 'DESC'], ['id', 'DESC']], limit: 2 });
    if (rows.length !== 1) fail('ledger_invalid');
    return { event: rows[0], metadata: replay.readMetadata(rows[0], voucher, stage, requestKey) };
  }
  function issue(origin, treatmentId, transaction, appointmentId = null) {
    const token = Object.freeze({ schema: SCHEMA });
    proofs.set(token, { owner, db, transaction, origin: normalizeOrigin(origin), treatmentId, appointmentId }); return token;
  }
  async function prepare({ voucherId, parentRequestKey, parentRequestSha256, actorId, sequence, slotPlanSha256, transaction }) {
    tx(transaction);
    const voucher = await db.PatientVoucher.findByPk(voucherId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!voucher || voucher.source_system === 'treatment_program' || !['active','pending'].includes(voucher.status)) fail('scope_changed');
    const { event, metadata } = await ledger(voucher, 'prepared', parentRequestKey, transaction);
    const intent = metadata.intent, slot = intent.slots?.[sequence - 1];
    if (metadata.actor_id !== actorId || metadata.request_sha256 !== parentRequestSha256
      || !v.positiveId(sequence) || slot?.sequence !== sequence || slot.booking_plan_sha256 !== slotPlanSha256
      || intent.profile?.version !== 4 || !intent.profile.phases?.length || !slot.phases?.length
      || Number(voucher.treatment_id) !== Number(intent.treatment_id)
      || v.hash(purchaseReferences(voucher)) !== v.hash(intent.purchase)
      || !Number.isFinite(Number(voucher.available_units)) || Number(voucher.available_units) < intent.configuration.count) fail('prepared_changed');
    return issue({ schema: SCHEMA, voucher_id: Number(voucher.id), voucher_public_id: voucher.public_id,
      clinic_id: Number(voucher.clinic_id), patient_id: Number(voucher.patient_id), actor_id: actorId,
      prepared_event_id: String(event.id), parent_request_key: parentRequestKey, parent_request_sha256: parentRequestSha256,
      sequence, slot_booking_plan_sha256: slotPlanSha256, purchase_references: purchaseReferences(voucher) },
    Number(intent.treatment_id), transaction);
  }
  async function forVisit({ visit, appointment, transaction }) {
    tx(transaction);
    if (!db.AppointmentVisitBirthRequest) fail('guard_unavailable');
    const row = v.plain(appointment), enrollment = v.object(visit.runtime_enrollment);
    const origin = normalizeOrigin(enrollment.origin);
    if (Number(visit.clinic_id) !== origin.clinic_id || Number(visit.patient_id) !== origin.patient_id
      || Number(visit.owner_appointment_id) !== Number(row.id_cita)
      || enrollment.birth_request_key !== childRequestKey(origin) || enrollment.actor_id !== origin.actor_id) fail('scope_changed');
    // Nonlocking identity read: booking already owns Voucher→Cita; dispatch
    // owns Cita→visit. Never invert that lock order to reread mutable balances.
    const voucher = await db.PatientVoucher.findByPk(origin.voucher_id, { transaction });
    if (!voucher || voucher.public_id !== origin.voucher_public_id || Number(voucher.clinic_id) !== origin.clinic_id
      || Number(voucher.patient_id) !== origin.patient_id) fail('scope_changed');
    const prepared = await ledger(voucher, 'prepared', origin.parent_request_key, transaction);
    const committed = await ledger(voucher, 'committed', origin.parent_request_key, transaction);
    const intent = prepared.metadata.intent, slot = intent.slots?.[origin.sequence - 1];
    const receipt = replay.receiptFromMetadata(committed.metadata, prepared.metadata);
    if (String(prepared.event.id) !== origin.prepared_event_id || prepared.metadata.actor_id !== origin.actor_id
      || prepared.metadata.request_sha256 !== origin.parent_request_sha256 || slot?.sequence !== origin.sequence
      || slot.booking_plan_sha256 !== origin.slot_booking_plan_sha256
      || v.hash(intent.purchase) !== v.hash(origin.purchase_references)
      || receipt.created[origin.sequence - 1]?.id !== Number(row.id_cita)) fail('receipt_invalid');
    const request = await db.AppointmentVisitBirthRequest.findOne({ transaction, where: {
      clinic_id: origin.clinic_id, request_key: enrollment.birth_request_key } });
    if (!request || Number(request.appointment_id) !== Number(row.id_cita) || request.visit_id !== visit.id
      || Number(request.patient_id) !== origin.patient_id || Number(request.actor_id) !== origin.actor_id
      || request.request_sha256 !== enrollment.birth_request_sha256) fail('receipt_invalid');
    // Birth times/plan are intentionally not compared with the CURRENT row:
    // legitimate canonical mutations own revision/snapshot authorization.
    const proof = issue(origin, Number(intent.treatment_id), transaction, Number(row.id_cita));
    proofOrigin(proof, { appointment: row, transaction, db }); return proof;
  }
  function ownProof(token, transaction) {
    if (proofs.get(token)?.owner !== owner) fail('server_origin_required');
    return proofOrigin(token, { transaction, db });
  }
  return Object.freeze({ prepare, forVisit, ownProof });
}
module.exports = { SCHEMA, normalizeOrigin, childRequestKey, proofOrigin, createVoucherBookingOriginReader };
