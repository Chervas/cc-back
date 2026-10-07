'use strict';

const { bookingSegments } = require('./appointment-booking-segments');
const { normalizeBookingProfile } = require('./booking-profile');
const { isDefaultAttention } = require('./booking-attention');
const ms = value => new Date(value).getTime();
const intersects = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
const get = (row, key) => row?.get ? row.get(key) : row?.[key];
function parse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

/** Internal calendar evidence only. Never patient identity, names or notes.
 * A boolean supplied by the caller is not evidence: validate the frozen
 * snapshot, geometry and ALL persisted staff intervals for this clinician. */
function attentionVisitOrigin({ appointment, doctorId, occupancies = [] }) {
  const id = Number(get(appointment, 'id_cita'));
  const start = get(appointment, 'inicio'), end = get(appointment, 'fin');
  const booking = parse(get(appointment, 'booking_attention_snapshot'));
  const clinicId = Number(get(appointment, 'clinica_id'));
  const rows = occupancies.filter(row => Number(row.appointment_id) === id && Number(row.doctor_id) === Number(doctorId));
  const intervals = rows.map(row => ({ start: row.start_at, end: row.end_at })).sort((a, b) => ms(a.start) - ms(b.start));
  let covered = ms(start);
  for (const interval of intervals) if (ms(interval.start) <= covered) covered = Math.max(covered, ms(interval.end));
  const unknown = { appointment_id: id, clinic_id: clinicId, start, end, verified: false, version: booking?.profile?.version === 4 ? 4 : null,
    partial: !Number.isFinite(covered) || covered < ms(end), phases: [] };
  if (!Number.isSafeInteger(clinicId) || clinicId < 1 || !Number.isFinite(ms(start)) || !Number.isFinite(ms(end)) || ms(start) >= ms(end) || !rows.length
    || booking?.profile?.version !== 4 || !Array.isArray(booking.attention_requirements_pending) || booking.attention_requirements_pending.length) return unknown;
  let profile;
  try { profile = normalizeBookingProfile(booking.profile); } catch { return unknown; }
  if (!bookingSegments({ id_cita: id, inicio: start, fin: end, import_metadata: { booking } }, { includeClinicalLabels: false }).length) return unknown;
  const phases = booking.phases.map((phase, index) => ({ phase, required: profile.phases[index] }))
    .filter(({ phase }) => phase.doctor_ids.includes(Number(doctorId)));
  const expected = phases.flatMap(({ phase }) => (phase.staff_intervals || [{ start_at: phase.start_at, end_at: phase.end_at }])
    .map(interval => ({ phase_key: phase.key, start: interval.start_at, end: interval.end_at })));
  if (!expected.length || expected.some(interval => !rows.some(row => row.phase_key === interval.phase_key
    && ms(row.start_at) === ms(interval.start) && ms(row.end_at) === ms(interval.end)))
    || rows.some(row => !expected.some(interval => row.phase_key === interval.phase_key
      && ms(row.start_at) === ms(interval.start) && ms(row.end_at) === ms(interval.end)))) return unknown;
  return { appointment_id: id, clinic_id: clinicId, start, end, version: 4, verified: true, partial: unknown.partial,
    phases: phases.map(({ phase, required }) => ({ key: phase.key, start: phase.start_at, end: phase.end_at,
      partial: !!required.staff_attention?.some(policy => !isDefaultAttention(policy)),
      ...(required.preparation_sharing ? { preparation_sharing: required.preparation_sharing,
        start_window_minutes: required.staff_attention[0].start_window_minutes } : {}) })) };
}

/** Sharing concerns different visits, not the simultaneous steps within ONE
 * visit. Saved intervals remain fixed; matching origins never releases them. */
function attentionVisitConflict(resource, { phase, visitStart, start, end, policies }) {
  const partial = policies.some(policy => !isDefaultAttention(policy));
  const visits = resource?.attention_visits || [];
  for (const visit of visits) {
    if (!intersects(visit, { start, end })) continue;
    if (!visit.verified) {
      if (partial || visit.partial || visit.version === 4) return { code: 'preparation_origin_unverified',
        message: 'Hay otra visita cuyo tiempo de atención no está acreditado. Se conserva su reserva completa; no puede compartirse la preparación.' };
      continue;
    }
    for (const origin of visit.phases) {
      if (!intersects(origin, { start, end }) || !partial && !origin.partial) continue;
      if (!Number.isSafeInteger(resource?.clinic_id) || resource.clinic_id !== visit.clinic_id) return { code: 'preparation_other_clinic',
        message: 'La reserva del profesional pertenece a otra clínica; no puede utilizarse para compartir esta preparación.' };
      if (phase.preparation_sharing?.mode !== 'same_start' || origin.preparation_sharing?.mode !== 'same_start') return {
        code: 'preparation_sharing_not_enabled', message: 'La preparación compartida no está autorizada explícitamente en ambas visitas.' };
      if (ms(visitStart) !== ms(visit.start)) return { code: 'preparation_start_mismatch',
        message: 'Estas visitas no empiezan a la misma hora. Sólo se pueden compartir preparaciones con el mismo inicio de visita.' };
      if (policies.length !== 1 || policies[0].start_window_minutes !== origin.start_window_minutes) return {
        code: 'preparation_window_mismatch', message: 'Las visitas tienen distintas ventanas iniciales de preparación. No puede compartirse este tiempo.' };
    }
  }
  // A supplied occupancy lacking visit evidence must not grant partial care
  // capacity. Bare intervals without appointment IDs may be calendar blocks.
  if (partial && (resource?.busy || []).some(row => row.appointment_id != null
    && intersects(row, { start, end }) && !visits.some(visit => visit.appointment_id === Number(row.appointment_id)))) return {
      code: 'preparation_origin_unverified', message: 'No se puede acreditar el origen de otra reserva del profesional. No se libera atención parcial para esta visita.' };
  return null;
}

const attentionVisitsAllowStep = (resource, options) => attentionVisitConflict(resource, options) === null;

module.exports = { attentionVisitOrigin, attentionVisitsAllowStep, attentionVisitConflict };
