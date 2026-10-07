'use strict';

const crypto = require('node:crypto');
const { parseSeriesStart } = require('./voucher-schedule-calendar');
const { resolveBookingProfileDuration, durationSelectionForRequest } = require('./booking-profile-duration');

const SOURCE = 'voucher_booking_replay_v1';
const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_BYTES = 1024 * 1024;
function fail(code, message, statusCode = 409) { throw Object.assign(new Error(message), { code, statusCode }); }
function enabled(environment = process.env) { return environment.VOUCHER_BOOKING_REPLAY_ENABLED === 'true'; }
function key(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('voucher_booking_request_invalid', 'Actualiza la propuesta de citas del bono.', 400);
  return value;
}
function sha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) fail('voucher_booking_request_invalid', 'Actualiza la propuesta de citas del bono.', 400);
  return value;
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.keys(value).sort()
    .filter(name => value[name] !== undefined).map(name => [name, canonical(value[name])]));
  fail('voucher_booking_receipt_invalid', 'No se puede verificar la referencia guardada de esta reserva.');
}
function hash(value) {
  const bytes = JSON.stringify(canonical(value));
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail('voucher_booking_receipt_invalid', 'La propuesta excede el tamaño verificable.');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function eventType(stage, requestKey) {
  if (!['prepared', 'committed'].includes(stage)) fail('voucher_booking_receipt_invalid', 'Referencia de reserva no válida.');
  // UUID in the indexed event_type gives a bounded exact lookup using the
  // existing (patient_id, clinic_id, event_type, occurred_at) index. Never
  // scan JSON or manufacture a timestamp as the request identity.
  return `voucher.booking.${stage}.${key(requestKey)}`;
}
function selectionsForPlan(plan) {
  if (!plan.bookingProfile) return null;
  return Object.fromEntries(plan.appointments.map(slot => [String(slot.sequence), Object.fromEntries(slot.phases.map(phase => {
    const choice = { installation_id: Number(phase.installation_id) };
    if (plan.bookingProfile.phases.find(row => row.key === phase.key).professionals.mode === 'any') choice.doctor_id = Number(phase.doctor_ids[0]);
    return [phase.key, choice];
  }))]));
}
function intentForPlan(plan, actorId) {
  if (plan.has_conflicts) fail('voucher_schedule_conflicts', 'Actualiza los huecos de la propuesta.');
  if (!Number.isSafeInteger(actorId) || actorId < 1) fail('unauthenticated', 'Usuario no autenticado.', 401);
  const voucher = plan.rawVoucher;
  return clone({ version: VERSION, actor_id: actorId, voucher_id: Number(voucher.id), voucher_public_id: voucher.public_id,
    clinic_id: Number(voucher.clinic_id), patient_id: Number(voucher.patient_id), treatment_id: Number(voucher.treatment_id),
    // Original purchase references are evidence, never a way to alter payment,
    // balance, activation or consumption from this booking request.
    purchase: { budget_id: voucher.budget_id == null ? null : String(voucher.budget_id),
      budget_line_key: voucher.budget_line_key || null, source_system: voucher.source_system || null,
      source_reference: voucher.source_reference || null },
    configuration: plan.configuration, treatment_name: plan.treatment?.nombre || voucher.name,
    template: plan.physicalTemplate || null, profile: plan.bookingProfile || null,
    duration_selection: plan.durationSelection || null, selections: selectionsForPlan(plan),
    slots: plan.appointments.map(slot => ({ sequence: slot.sequence, start_at: slot.start_at, end_at: slot.end_at,
      ...(slot.phases ? { phases: slot.phases, warnings: slot.warnings || [],
        booking_plan_sha256: slot.booking_plan_sha256,
        requires_priority_acknowledgement: slot.requires_priority_acknowledgement === true } : {}) })) });
}
function preparedMetadata(plan, actorId) {
  const intent = intentForPlan(plan, actorId), requestKey = crypto.randomUUID();
  return { version: VERSION, actor_id: actorId, voucher_id: intent.voucher_id, request_key: requestKey, request_sha256: hash(intent), intent };
}
function readMetadata(event, voucher, stage, requestKey) {
  const row = event?.toJSON ? event.toJSON() : event;
  let metadata = row?.metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = null; } }
  if (!row || row.source !== SOURCE || row.event_type !== eventType(stage, requestKey)
    || Number(row.clinic_id) !== Number(voucher.clinic_id) || Number(row.patient_id) !== Number(voucher.patient_id)
    || metadata?.version !== VERSION || Number(metadata.voucher_id) !== Number(voucher.id)
    || !Number.isSafeInteger(metadata.actor_id) || metadata.actor_id < 1 || Number(row.actor_user_id) !== metadata.actor_id
    || metadata.request_key !== requestKey || !SHA.test(metadata.request_sha256 || '')) {
    fail('voucher_booking_receipt_invalid', 'No se puede verificar la referencia guardada de esta reserva.');
  }
  if (stage === 'prepared' && (hash(metadata.intent) !== metadata.request_sha256
    || Number(metadata.intent.voucher_id) !== Number(voucher.id) || metadata.intent.voucher_public_id !== voucher.public_id
    || Number(metadata.intent.clinic_id) !== Number(voucher.clinic_id) || Number(metadata.intent.patient_id) !== Number(voucher.patient_id)
    || metadata.intent.actor_id !== metadata.actor_id)) {
    fail('voucher_booking_receipt_invalid', 'La propuesta guardada no coincide con este bono.');
  }
  return clone(metadata);
}
function integer(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail('voucher_booking_request_conflict', 'La propuesta cambió. Comprueba los huecos otra vez.');
  return number;
}
function validatePayload(intent, payload, normalizeSelections) {
  const config = intent.configuration;
  if (parseSeriesStart(payload.start_at, config.timezone).toISOString() !== intent.slots[0].start_at
    || integer(payload.count, config.count) !== config.count
    || integer(payload.interval_days, config.interval_days) !== config.interval_days
    || integer(payload.duration_minutes, config.duration_minutes) !== config.duration_minutes
    || integer(payload.doctor_id, config.doctor_id) !== config.doctor_id
    || integer(payload.installation_id, config.installation_id) !== config.installation_id) {
    fail('voucher_booking_request_conflict', 'La propuesta cambió. Comprueba los huecos otra vez.');
  }
  if (intent.duration_selection || Object.hasOwn(payload, 'phase_durations')) {
    const selection = durationSelectionForRequest({ clinical_config: { booking_profile: intent.template } }, payload);
    const result = resolveBookingProfileDuration(intent.template, { durationSelection: selection });
    if (hash(result.profile) !== hash(intent.profile)) fail('voucher_booking_request_conflict', 'La duración elegida no coincide con la propuesta.');
  }
  if (Object.hasOwn(payload, 'booking_selection') && Object.hasOwn(payload, 'booking_selections_by_sequence')) {
    fail('voucher_schedule_selection_invalid', 'Elige una selección común o una selección por cita, no ambas.', 400);
  }
  const perDate = payload.booking_selections_by_sequence;
  if (perDate !== undefined && (!perDate || typeof perDate !== 'object' || Array.isArray(perDate)
    || Object.keys(perDate).length !== config.count || Object.keys(perDate).some(sequence => !Object.hasOwn(intent.selections || {}, sequence)))) {
    fail('voucher_schedule_selection_invalid', 'Conserva la selección de cada cita de la serie.', 400);
  }
  if (perDate !== undefined || Object.hasOwn(payload, 'booking_selection')) {
    if (!intent.profile) fail('voucher_schedule_selection_invalid', 'Esta reserva no tiene fases configuradas.', 400);
    for (let sequence = 1; sequence <= config.count; sequence++) {
      const supplied = normalizeSelections(perDate ? perDate[String(sequence)] : payload.booking_selection, intent.profile);
      for (const [phase, choice] of Object.entries(supplied)) for (const [resource, id] of Object.entries(choice)) {
        if (id !== intent.selections[String(sequence)]?.[phase]?.[resource]) fail('voucher_booking_request_conflict',
          'Los recursos elegidos no coinciden con los huecos comprobados.');
      }
    }
  }
  if (intent.slots.some(slot => slot.requires_priority_acknowledgement) && payload.booking_priority_acknowledged !== true) {
    fail('booking_priority_confirmation_required', 'Confirma la reserva con el profesional alternativo indicado.');
  }
}
function payloadForIntent(intent, payload) {
  const result = { ...payload, start_at: intent.slots[0].start_at, count: intent.configuration.count,
    interval_days: intent.configuration.interval_days, doctor_id: intent.configuration.doctor_id,
    installation_id: intent.configuration.installation_id, duration_minutes: intent.configuration.duration_minutes };
  delete result.booking_selection; delete result.booking_selections_by_sequence;
  if (intent.selections) result.booking_selections_by_sequence = clone(intent.selections);
  if (intent.duration_selection) {
    // Multi-phase templates need explicit per-phase minutes; a total cannot
    // be used to invent the allocation of those minutes across techniques.
    if (intent.template.phases.length > 1) result.phase_durations = clone(intent.duration_selection.phase_durations || payload.phase_durations);
    else result.duration_minutes = intent.duration_selection.duration_minutes;
  }
  return result;
}
function receiptForAppointments(appointments) {
  return { created: appointments.map(appointment => ({ id: Number(appointment.id_cita),
    start_at: new Date(appointment.inicio).toISOString(), end_at: new Date(appointment.fin).toISOString(), title: appointment.titulo })) };
}
function committedMetadata(prepared, receipt) {
  return { version: VERSION, actor_id: prepared.actor_id, voucher_id: prepared.voucher_id, request_key: prepared.request_key,
    request_sha256: prepared.request_sha256, receipt, receipt_sha256: hash(receipt) };
}
function receiptFromMetadata(committed, prepared) {
  const receipt = committed.receipt, slots = prepared.intent.slots;
  if (committed.request_sha256 !== prepared.request_sha256 || committed.actor_id !== prepared.actor_id || hash(receipt) !== committed.receipt_sha256
    || !Array.isArray(receipt?.created) || receipt.created.length !== slots.length
    || new Set(receipt.created.map(row => row.id)).size !== slots.length
    || receipt.created.some((row, index) => !Number.isSafeInteger(row.id) || row.id < 1
      || row.start_at !== slots[index].start_at || row.end_at !== slots[index].end_at || typeof row.title !== 'string')) {
    fail('voucher_booking_receipt_invalid', 'No se puede verificar el resultado guardado de esta reserva.');
  }
  return clone(receipt);
}
module.exports = { SOURCE, VERSION, enabled, key, sha, hash, eventType, intentForPlan, preparedMetadata, readMetadata,
  validatePayload, payloadForIntent, receiptForAppointments, committedMetadata, receiptFromMetadata };
