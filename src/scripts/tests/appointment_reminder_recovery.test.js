'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/appointment-reminder-recovery');
const now = Date.parse('2026-10-18T11:00:00Z');
const valid = () => ({ job_id: 10, status: 'completed', result_reason: 'invalid_schedule',
  payload: { __runtime_namespace: 'staging', trigger_type: 'appointment_reminder_window',
    scheduled_for: '2026-10-18T07:00:00.000Z', template_key: 'reminder', appointment_id: 20 },
  active: 1, published_at: '2026-10-01 00:00:00', config: { schedule_moment: 'day_before' },
  template_key: 'reminder', template_id: 30, appointment_id: 20, clinic_id: 72, patient_id: 40,
  start_at: '2026-10-19 09:00:00', appointment_state: 'info_confirmada', provisional: 0 });
test('only original missed reminder for tomorrow is eligible', () => {
  assert.equal(C.validate(valid(), { day: '2026-10-18', now }).appointmentId, 20);
});
test('no reactivation of disabled, unpublished, consent, review or another runtime', () => {
  for (const patch of [{ active: 0 }, { published_at: null }, { status: 'failed' },
    { result_reason: 'template_not_active' }, { config: { schedule_moment: 'same_day' } },
    { payload: { ...valid().payload, trigger_type: 'appointment_after' } },
    { payload: { ...valid().payload, __runtime_namespace: 'dev' } }]) {
    assert.throws(() => C.validate({ ...valid(), ...patch }, { day: '2026-10-18', now }), /source_ineligible/);
  }
});
test('no past, historical, already confirmed, provisional or changed reservation', () => {
  for (const patch of [{ start_at: '2026-10-17 09:00:00' }, { start_at: '2026-10-20 09:00:00' },
    { appointment_state: 'recordatorio_confirmado' }, { appointment_state: 'cancelada' }, { provisional: 1 }]) {
    assert.throws(() => C.validate({ ...valid(), ...patch }, { day: '2026-10-18', now }));
  }
  assert.throws(() => C.validate(valid(), { day: '2026-10-17', now }));
});
test('snapshot changes, including recipe and suppression, invalidate reviewed digest', () => {
  const row = valid(), digest = C.validate(row, { day: '2026-10-18', now }).sourceDigest;
  for (const patch of [{ nodes: [{ id: 'changed' }] }, { import_metadata: { notification_suppression: { day_before: true } } },
    { patient_id: 41 }, { start_at: '2026-10-19 10:00:00' }]) {
    assert.notEqual(C.validate({ ...row, ...patch }, { day: '2026-10-18', now }).sourceDigest, digest);
  }
});
