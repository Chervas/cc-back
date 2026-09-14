'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const P = require('../../lib/whatsappRecoveryPolicy');
const configuration = { version: 1, approvalRef: 'fictitious-review-only', clinicId: 990001, assetId: 990002,
  timeZone: 'Europe/Madrid', createdDates: ['2026-09-13','2026-09-14'], detailsFromDate: '2026-09-16',
  reminderDate: '2026-09-15', reminderNotBefore: '2026-09-15T06:00:00.000Z', reminderNotAfter: '2026-09-15T06:15:00.000Z',
  expiresAt: '2026-09-15T22:00:00.000Z', includeConfirmedReminders: true, automaticBacklogReplay: false };
const now = new Date('2026-09-14T21:00:00.000Z');
function appointment(changes = {}) { return { id: 990003, clinicId: 990001, patientId: 990004, state: 'pendiente',
  startAt: '2026-09-16T08:00:00.000Z', endAt: '2026-09-16T08:30:00.000Z',
  createdAt: '2026-09-13T08:00:00.000Z', updatedAt: '2026-09-14T20:00:00.000Z',
  provisional: false, communicationAllowed: true, suppressed: false, ...changes }; }
const cleared = (a, at = now) => ({ status: 'cleared', revision: P.fingerprint(a), observedAt: at,
  unresolvedCancellation: false, unresolvedChange: false, unresolvedReply: false, coverage: 'gap_reviewed', reviewerId: 990005 });
function evaluate(a, changes = {}) { return P.evaluate({ configuration, appointment: a, purpose: 'appointment_details',
  deliveries: [], review: cleared(a, changes.now || now), now, ...changes }); }
test('the agreed creation and appointment dates use Madrid midnight rather than UTC', () => {
  assert.equal(evaluate(appointment({ createdAt: '2026-09-12T21:59:59.999Z' })).reason, 'outside_creation_dates');
  assert.equal(evaluate(appointment({ createdAt: '2026-09-12T22:00:00.000Z' })).eligible, true);
  assert.equal(evaluate(appointment({ createdAt: '2026-09-14T21:59:59.999Z' })).eligible, true);
  assert.equal(evaluate(appointment({ createdAt: '2026-09-14T22:00:00.000Z' })).reason, 'outside_creation_dates');
  assert.equal(evaluate(appointment({ startAt: '2026-09-15T21:59:59.999Z' })).reason, 'details_date_excluded');
  assert.equal(evaluate(appointment({ startAt: '2026-09-15T22:00:00.000Z' })).eligible, true);
});
test('the 08:00 reminder includes confirmed and unconfirmed appointments, but only within its useful window', () => {
  for (const state of ['pendiente','info_confirmada','recordatorio_confirmado']) {
    const a = appointment({ state, startAt: '2026-09-15T08:00:00.000Z', endAt: '2026-09-15T08:30:00.000Z' });
    const input = { purpose: 'same_day_reminder', phase: 'send', now: new Date('2026-09-15T06:00:00.000Z') };
    assert.equal(evaluate(a, input).eligible, true);
    assert.equal(evaluate(a, { ...input, now: new Date('2026-09-15T05:59:59.999Z') }).reason, 'reminder_not_due');
    assert.equal(evaluate(a, { ...input, now: new Date('2026-09-15T06:15:00.000Z') }).reason, 'reminder_window_expired');
    assert.equal(evaluate(a, { purpose: 'same_day_reminder' }).eligible, true, 'preview does not dispatch an early reminder');
  }
});
test('cancellation, requested changes, suppressions, another clinic and past appointments cannot be released', () => {
  for (const state of ['cancelada','completada','no_asistio','unknown','cambio_solicitado']) assert.equal(evaluate(appointment({ state })).eligible, false);
  for (const changes of [{ provisional: true }, { communicationAllowed: false }, { suppressed: true }]) assert.equal(evaluate(appointment(changes)).reason, 'communications_suppressed');
  assert.equal(evaluate(appointment({ clinicId: 990006 })).reason, 'outside_pilot');
  assert.equal(evaluate(appointment({ startAt: '2026-09-14T20:00:00Z' })).reason, 'appointment_not_future');
  assert.equal(evaluate(appointment(), { purpose: 'same_day_reminder' }).reason, 'outside_reminder_date');
  assert.equal(evaluate(appointment(), { now: new Date(configuration.expiresAt) }).reason, 'approval_expired');
});
test('accepted or uncertain messages cannot be replayed under a new approval or appointment revision', () => {
  const a = appointment();
  const delivery = { appointmentId: a.id, purpose: 'appointment_details', state: 'failed', handoff: 'not_started' };
  assert.equal(evaluate(a, { deliveries: [delivery] }).eligible, true);
  for (const state of ['accepted','sent','delivered','read']) assert.equal(evaluate(a, { deliveries: [{ ...delivery, state }] }).reason, 'already_communicated');
  for (const item of [{ handoff: 'unknown' }, { state: 'pending' }, { state: 'queued' }, { state: 'sending' }]) {
    assert.equal(evaluate(a, { deliveries: [{ ...delivery, ...item }] }).reason, 'delivery_needs_reconciliation');
  }
  const updated = appointment({ state: 'info_confirmada', updatedAt: '2026-09-14T20:59:00Z' });
  assert.equal(evaluate(a).intention, evaluate(updated, { configuration: { ...configuration, approvalRef: 'another-review' } }).intention);
  assert.equal(evaluate(updated, { deliveries: [{ ...delivery, state: 'sent', handoff: 'accepted' }] }).eligible, false);
});
test('reminders from an earlier appointment date do not suppress the current day and undated history needs reconciliation', () => {
  const a = appointment({ startAt: '2026-09-15T08:00:00.000Z', endAt: '2026-09-15T08:30:00.000Z' });
  const delivery = { appointmentId: a.id, purpose: 'same_day_reminder', state: 'sent', handoff: 'accepted' };
  const check = item => evaluate(a, { purpose: 'same_day_reminder', deliveries: [item] });
  assert.equal(check(delivery).reason, 'delivery_needs_reconciliation');
  assert.equal(check({ ...delivery, communicationDate: '2026-09-14' }).eligible, true);
  assert.equal(check({ ...delivery, communicationDate: '2026-09-15' }).reason, 'already_communicated');
  assert.equal(check({ ...delivery, communicationDate: '2026-09-15', state: 'failed', handoff: 'unknown' }).reason, 'delivery_needs_reconciliation');
});
test('acknowledged but missing inbound history requires review and never becomes an implicit green light', () => {
  const a = appointment();
  for (const review of [null, {}, { ...cleared(a), coverage: 'unknown' }, { ...cleared(a), reviewerId: null },
    { ...cleared(a), unresolvedCancellation: true }, { ...cleared(a), unresolvedChange: true }, { ...cleared(a), unresolvedReply: true }]) {
    assert.equal(evaluate(a, { review }).reason, 'inbound_review_required');
  }
  assert.equal(evaluate(a, { review: { ...cleared(a), coverage: 'complete', reviewerId: null } }).eligible, true);
  assert.equal(evaluate(appointment({ state: 'info_confirmada' }), { review: cleared(a) }).reason, 'inbound_review_required');
  assert.equal(evaluate(appointment({ createdAt: '2026-09-14T08:00:00Z' }), { review: cleared(a) }).reason, 'inbound_review_required');
  assert.equal(evaluate(a, { phase: 'send', review: cleared(a, new Date(now.getTime()-60001)) }).reason, 'inbound_review_stale');
});
test('malformed snapshots and attempts to broaden the approved scope fail closed', () => {
  for (const changes of [{ timeZone: 'UTC' }, { automaticBacklogReplay: true }, { includeConfirmedReminders: false },
    { reminderNotBefore: '2026-09-15T08:00:00.000Z' }, { reminderNotAfter: '2026-09-16T06:15:00.000Z' }]) {
    assert.throws(() => evaluate(appointment(), { configuration: { ...configuration, ...changes } }), /whatsapp_recovery_invalid/);
  }
  assert.throws(() => evaluate(appointment({ startAt: '2026-09-16 08:00:00' })), /whatsapp_recovery_invalid/);
  assert.throws(() => evaluate(appointment({ suppressed: undefined })), /whatsapp_recovery_invalid/);
  assert.throws(() => evaluate(appointment(), { deliveries: [{ appointmentId: 990003, purpose: 'appointment_details' }] }), /whatsapp_recovery_invalid/);
});
