'use strict';
// Deliberately has no database, queue, provider or credential dependency.
const { createHash } = require('node:crypto');
const PURPOSES = Object.freeze(['appointment_details', 'same_day_reminder']);
const ACTIVE = new Set(['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada']);
const CONFIRMED = new Set(['info_confirmada', 'recordatorio_confirmado']);
const TERMINAL_DELIVERY = new Set(['accepted', 'sent', 'delivered', 'read']);
function fail() { throw Object.assign(Error('whatsapp_recovery_invalid'), { code: 'whatsapp_recovery_invalid' }); }
const id = value => Number.isSafeInteger(value) && value > 0;
function instant(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))) fail();
  const time = new Date(value).getTime(); if (!Number.isFinite(time)) fail(); return time;
}
function localDate(value, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(instant(value)));
    const field = name => parts.find(part => part.type === name).value;
    return `${field('year')}-${field('month')}-${field('day')}`;
  } catch { fail(); }
}
function policy(value) {
  if (!value || value.version !== 1 || !id(value.clinicId) || !id(value.assetId)
    || typeof value.approvalRef !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(value.approvalRef)
    || value.timeZone !== 'Europe/Madrid' || value.reminderDate !== '2026-09-15'
    || JSON.stringify(value.createdDates) !== '["2026-09-13","2026-09-14"]'
    || value.detailsFromDate !== '2026-09-16' || value.reminderNotBefore !== '2026-09-15T06:00:00.000Z'
    || value.includeConfirmedReminders !== true || value.automaticBacklogReplay !== false
    || instant(value.expiresAt) <= instant(value.reminderNotBefore)
    || instant(value.reminderNotAfter) <= instant(value.reminderNotBefore)
    || instant(value.reminderNotAfter) > instant(value.reminderNotBefore) + 15 * 60_000
    || instant(value.expiresAt) > instant('2026-09-15T22:00:00.000Z')) fail();
  return structuredClone(value);
}
function fingerprint(appointment) {
  return createHash('sha256').update('cc-wa-appointment-v1\0').update(JSON.stringify([
    appointment.id, appointment.clinicId, appointment.patientId, appointment.state,
    new Date(instant(appointment.startAt)).toISOString(), new Date(instant(appointment.endAt)).toISOString(),
    new Date(instant(appointment.updatedAt)).toISOString(), appointment.provisional,
    appointment.communicationAllowed, appointment.suppressed, new Date(instant(appointment.createdAt)).toISOString(),
  ])).digest('hex');
}
function evaluate({ configuration, appointment: a, purpose, deliveries, review, now = new Date(), phase = 'preview' }) {
  const p = policy(configuration); const time = instant(now);
  if (!PURPOSES.includes(purpose) || !['preview', 'send'].includes(phase) || !a
    || !id(a.id) || !id(a.clinicId) || !id(a.patientId) || !Array.isArray(deliveries)
    || typeof a.provisional !== 'boolean' || typeof a.communicationAllowed !== 'boolean' || typeof a.suppressed !== 'boolean') fail();
  const revision = fingerprint(a);
  // This identity is independent of retries, approvals and appointment versions.
  // Replacing a Message or approval cannot silently create another communication.
  const intention = `${purpose}:${a.clinicId}:${a.id}:${purpose === 'same_day_reminder' ? p.reminderDate : 'initial'}`;
  const result = reason => ({ eligible: reason === 'eligible', reason, purpose, appointmentId: a.id,
    clinicId: a.clinicId, assetId: p.assetId, approvalRef: p.approvalRef, revision, intention,
    confirmed: CONFIRMED.has(a.state) });
  if (a.clinicId !== p.clinicId) return result('outside_pilot');
  if (time >= instant(p.expiresAt)) return result('approval_expired');
  if (!ACTIVE.has(a.state)) return result(a.state === 'cambio_solicitado' ? 'change_requested' : 'appointment_inactive');
  if (a.provisional || !a.communicationAllowed || a.suppressed) return result('communications_suppressed');
  if (instant(a.endAt) <= instant(a.startAt) || instant(a.startAt) <= time) return result('appointment_not_future');
  const date = localDate(a.startAt, p.timeZone);
  if (purpose === 'appointment_details') {
    if (!p.createdDates.includes(localDate(a.createdAt, p.timeZone))) return result('outside_creation_dates');
    if (date < p.detailsFromDate) return result('details_date_excluded');
  } else {
    if (date !== p.reminderDate) return result('outside_reminder_date');
    if (time >= instant(p.reminderNotAfter)) return result('reminder_window_expired');
    if (phase === 'send' && time < instant(p.reminderNotBefore)) return result('reminder_not_due');
  }
  for (const delivery of deliveries) {
    if (!delivery || !id(delivery.appointmentId) || !PURPOSES.includes(delivery.purpose)
      || !['not_started', 'accepted', 'unknown'].includes(delivery.handoff)) fail();
    if (delivery.appointmentId !== a.id || delivery.purpose !== purpose) continue;
    if (purpose === 'same_day_reminder') {
      if (typeof delivery.communicationDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(delivery.communicationDate)) return result('delivery_needs_reconciliation');
      if (delivery.communicationDate !== p.reminderDate) continue;
    }
    if (TERMINAL_DELIVERY.has(delivery.state) || delivery.handoff === 'accepted') return result('already_communicated');
    if (delivery.handoff === 'unknown' || ['queued','sending','pending'].includes(delivery.state)) return result('delivery_needs_reconciliation');
    if (delivery.handoff !== 'not_started' || !['failed','cancelled','not_sent'].includes(delivery.state)) fail();
  }
  // A historical HTTP 200 followed by a dropped payload is an acknowledged gap.
  // Empty local history is never accepted as evidence of no patient response.
  if (!review || review.revision !== revision || review.status !== 'cleared'
    || review.unresolvedCancellation !== false || review.unresolvedChange !== false
    || review.unresolvedReply !== false || !['complete', 'gap_reviewed'].includes(review.coverage)
    || review.coverage === 'gap_reviewed' && !id(review.reviewerId)) return result('inbound_review_required');
  if (instant(review.observedAt) > time || phase === 'send' && time - instant(review.observedAt) > 60_000) return result('inbound_review_stale');
  return result('eligible');
}
module.exports = { PURPOSES, localDate, policy, fingerprint, evaluate };
