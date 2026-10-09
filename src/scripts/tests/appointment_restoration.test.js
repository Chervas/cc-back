'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const R = require('../../lib/appointment-restoration');
const { assertCareStatusChange } = require('../../lib/appointment-care');
const row = () => ({ id_cita: 1, clinica_id: 2, paciente_id: 3, estado: 'cancelada',
  inicio: '2026-10-09T10:00Z', fin: '2026-10-09T10:30Z', doctor_id: 4, instalacion_id: null });
const event = (status = 'pendiente', id = 1) => ({ id, clinic_id: 2, patient_id: 3,
  occurred_at: '2026-10-09T12:00Z', event_type: 'appointment.status_changed',
  metadata: { appointment_id: id, previous_status: status, new_status: 'cancelada' } });
const plan = (rows = [row()], events = [event()], actorId = 9) => R.buildRestorationPlan({ rows, events, actorId, selectedId: 1 });
test('restoration preserves each evidenced pre-cancellation state, never fabricates confirmation', () => {
  for (const status of R.ACTIVE) {
    const current = row();
    if (status === 'ha_acudido') Object.assign(current, { arrived_at: '2026-10-09T10:01Z', care_schedule_start: current.inicio });
    const result = plan([current], [event(status)]);
    assert.equal(R.preview(result).previous_status, status);
    assert.equal(R.preview(result).communications_suppressed, true);
    assert.doesNotThrow(() => R.assertRestorationAcknowledgement(result, result.acknowledgement));
  }
});
test('history, patient, clinic, latest transition and clinical evidence are required', () => {
  for (const changes of [{ estado: 'pendiente' }, { care_started_at: '2026-10-09T10:01Z' },
    { care_completed_at: '2026-10-09T10:20Z' }, { care_legacy_attendance: true }, { es_provisional: true },
    { arrived_at: '2026-10-09T10:01Z', care_schedule_start: row().inicio }]) assert.throws(() => plan([{ ...row(), ...changes }]));
  for (const events of [[], [event('completada')], [event('no_asistio')], [{ ...event(), patient_id: 99 }],
    [{ ...event(), clinic_id: 99 }], [event(), { ...event(), id: 2, occurred_at: '2026-10-09T13:00Z',
      metadata: { appointment_id: 1, previous_status: 'cancelada', new_status: 'pendiente' } }]])
    assert.throws(() => plan([row()], events), { code: 'booking_restore_history_required' });
});
test('actor, audit, linked revision and every booking field invalidate stale acknowledgement', () => {
  const original = plan();
  for (const change of [{ doctor_id: 5 }, { instalacion_id: 6 }, { fin: '2026-10-09T10:40Z' },
    { paciente_id: 10 }]) {
    const events = [{ ...event(), patient_id: change.paciente_id || 3 }];
    assert.throws(() => R.assertRestorationAcknowledgement(plan([{ ...row(), ...change }], events), original.acknowledgement),
      { code: 'booking_restore_changed' });
  }
  assert.throws(() => R.assertRestorationAcknowledgement(plan([row()], [event()], 10), original.acknowledgement), { code: 'booking_restore_changed' });
  assert.throws(() => R.assertRestorationAcknowledgement(plan([row()], [{ ...event(), id: 2 }]), original.acknowledgement), { code: 'booking_restore_changed' });
});
test('only administrative recovery can preserve an existing arrival; cannot forge or complete care', () => {
  const current = { ...row(), arrived_at: '2026-10-09T10:01Z', care_schedule_start: row().inicio };
  const now = new Date('2026-10-09T12:00Z');
  assert.doesNotThrow(() => assertCareStatusChange(current, { estado: 'ha_acudido' }, now, { restoreExistingArrival: true }));
  assert.throws(() => assertCareStatusChange(current, { estado: 'ha_acudido' }, now), { code: 'care_action_required' });
  for (const value of [row(), { ...current, arrived_at: '2026-10-10T10:01Z' }, { ...current, care_schedule_start: '2026-10-08T10:00Z' }])
    assert.throws(() => assertCareStatusChange(value, { estado: 'ha_acudido' }, now, { restoreExistingArrival: true }), { code: 'care_action_required' });
  assert.throws(() => assertCareStatusChange(current, { estado: 'en_atencion' }, now, { restoreExistingArrival: true }), { code: 'care_action_required' });
});
test('administrative arrival recovery records the audit but never invokes BS operational direction observers', async () => {
  const file = require.resolve('../../services/temporaryPatientDirection.service'), saved = require.cache[file];
  let observations = 0; const events = [];
  require.cache[file] = { id: file, filename: file, loaded: true,
    exports: { observeAppointment: async () => { observations++; } } };
  try {
    const { recordAppointmentStatusChange } = require('../../services/appointmentActivity.service');
    for (const clinic of [66, 72, 77]) await recordAppointmentStatusChange({ appointment: { ...row(), clinica_id: clinic },
      previousStatus: 'cancelada', newStatus: 'ha_acudido', actorUserId: 9, administrativeRestore: true,
      eventModel: { create: async event => { events.push(event); return event; } } });
    assert.equal(observations, 0); assert.equal(events.length, 3);
    assert(events.every(event => event.metadata.previous_status === 'cancelada' && event.metadata.new_status === 'ha_acudido'));
    await recordAppointmentStatusChange({ appointment: { ...row(), clinica_id: 66 }, previousStatus: 'recordatorio_confirmado',
      newStatus: 'ha_acudido', actorUserId: 9, eventModel: { create: async event => event } });
    assert.equal(observations, 1, 'Normal new attendance retains its existing observer');
  } finally { if (saved) require.cache[file] = saved; else delete require.cache[file]; }
});
