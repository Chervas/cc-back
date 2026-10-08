'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { careState, careActionPatch, assertCareAction, assertCareStatusChange,
  hasCompletedAppointmentCare, allowsAppointmentAutomation } = require('../../lib/appointment-care');
const { CITA_STATUSES, CITA_ALLOWED_TRANSITIONS, hasAttendedAppointment } = require('../../lib/status-catalog');
const { assertAppointmentEligibility } = require('../../lib/whatsappAppointmentEligibility');
const now = new Date('2026-10-08T12:00:00Z');
const base = { id_cita: 11, clinica_id: 3, paciente_id: 7, estado: 'recordatorio_confirmado',
  inicio: '2026-10-08T11:00:00Z', fin: '2026-10-08T12:00:00Z', es_provisional: false };
const arrived = { ...base, ...careActionPatch(base, 'arrive', { now, actorId: 9 }) };
const started = { ...arrived, ...careActionPatch(arrived, 'start', { now, actorId: 10 }) };
const completed = { ...started, ...careActionPatch(started, 'finish', { now, actorId: 10 }) };

test('native lifecycle separates arrival, care and completion with authenticated actors', () => {
  assert.equal(arrived.estado, 'ha_acudido');
  assert.equal(arrived.arrived_by, 9);
  assert.equal(arrived.care_started_at, null);
  assert.equal(arrived.care_completed_at, null);
  assert.equal(started.estado, 'en_atencion');
  assert.equal(started.care_started_by, 10);
  assert.equal(completed.estado, 'completada');
  assert.equal(completed.care_completed_by, 10);
  assert.equal(completed.arrived_at, arrived.arrived_at);
  assert.equal(hasCompletedAppointmentCare(completed), true);
  assert.equal(careState(completed, now).can_complete, false);
});
test('the five existing states remain unchanged, and only started care can finish', () => {
  assert.deepEqual(CITA_STATUSES.slice(0, 5).map(row => row.value),
    ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado']);
  assert.deepEqual(CITA_ALLOWED_TRANSITIONS.en_atencion, ['completada']);
  assert.equal(CITA_ALLOWED_TRANSITIONS.recordatorio_confirmado.includes('completada'), false);
});
test('arrival/start/finish capabilities are consistent at every stage', () => {
  for (const [row, expected] of [[base, [true, false, false]], [arrived, [false, true, false]],
    [started, [false, true, true]], [completed, [false, false, false]]]) {
    const state = careState(row, now);
    assert.deepEqual([state.can_arrive, state.can_start, state.can_complete], expected);
  }
});
for (const estado of ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada']) {
  test(`${estado}: patient confirmation never constitutes attendance or completion`, () => {
    const row = { ...base, estado };
    assert.equal(hasAttendedAppointment(row), false);
    assert.equal(hasCompletedAppointmentCare(row), false);
    assert.throws(() => assertCareAction(row, 'start', now), { code: 'care_arrival_required' });
    assert.throws(() => assertCareAction(row, 'finish', now), { code: 'care_start_required' });
  });
}
for (const estado of ['cancelada', 'no_asistio', 'completada']) {
  test(`${estado}: cannot record a fresh arrival or start`, () => {
    for (const action of ['arrive', 'start']) assert.throws(() => assertCareAction({ ...base, estado }, action, now),
      { code: 'care_appointment_inactive' });
  });
}
test('future, provisional and patientless appointments cannot acquire care evidence', () => {
  assert.throws(() => assertCareAction({ ...base, inicio: '2026-10-09T11:00:00Z' }, 'arrive', now), { code: 'care_too_early' });
  for (const change of [{ es_provisional: true }, { paciente_id: null }]) {
    assert.throws(() => assertCareAction({ ...base, ...change }, 'arrive', now), { code: 'care_appointment_inactive' });
  }
  for (const actorId of [null, 0, -1, 1.2, 'invalid']) {
    assert.throws(() => careActionPatch(base, 'arrive', { now, actorId }), { code: 'care_actor_required' });
  }
});
test('evidence from a previous reservation never authorizes completion', () => {
  const moved = { ...completed, inicio: '2026-10-09T11:00:00Z' };
  assert.equal(hasCompletedAppointmentCare(moved), false);
  assert.equal(careState(moved).arrived_at, null);
  assert.equal(careState(moved).started_at, null);
  assert.equal(careState(moved).completed_at, null);
});
test('history preserves attendance without fabricating finalization', () => {
  const legacy = { ...base, estado: 'ha_acudido', care_legacy_attendance: true };
  assert.equal(hasAttendedAppointment(legacy), true);
  assert.equal(hasCompletedAppointmentCare(legacy), false);
  for (const action of ['arrive', 'start', 'finish']) assert.throws(() => assertCareAction(legacy, action, now),
    { code: 'care_legacy_attendance' });
  assert.throws(() => assertCareStatusChange(legacy, { estado: 'recordatorio_confirmado' }), { code: 'care_legacy_attendance' });
});
test('generic state writers cannot forge arrival/start or rewind clinical evidence', () => {
  for (const estado of ['ha_acudido', 'en_atencion']) {
    assert.throws(() => assertCareStatusChange(base, { estado }), { code: 'care_action_required' });
    assert.throws(() => assertCareStatusChange(null, { estado }), { code: 'care_action_required' });
  }
  assert.doesNotThrow(() => assertCareStatusChange(started, { estado: 'completada' }));
  assert.throws(() => assertCareStatusChange(started, { estado: 'recordatorio_confirmado' }), { code: 'care_already_started' });
  assert.throws(() => assertCareStatusChange(completed, { estado: 'ha_acudido' }), { code: 'care_already_completed' });
  for (const row of [started, completed, { ...arrived, care_legacy_attendance: true }]) {
    for (const change of [{ paciente_id: 99 }, { clinica_id: 99 }, { tratamiento_id: 99 },
      { inicio: '2026-10-09T11:00:00Z' }, { fin: '2026-10-08T12:30:00Z' }]) {
      assert.throws(() => assertCareStatusChange(row, change), { code: 'care_reservation_locked' });
    }
    assert.doesNotThrow(() => assertCareStatusChange(row, { nota: 'Reception note' }));
  }
});
const beforeTriggers = ['appointment_created', 'appointment_confirmed', 'appointment_rescheduled', 'appointment_reminder_window', 'consent_required'];
const afterTriggers = ['appointment_completed', 'appointment_after'];
for (const [label, row, before, after] of [['confirmed', base, true, false], ['arrived', arrived, false, false],
  ['started', started, false, false], ['completed', completed, false, true],
  ['historical attendance', { ...arrived, care_legacy_attendance: true }, false, false],
  ['old completion without evidence', { ...base, estado: 'completada' }, false, false]]) {
  for (const trigger of [...beforeTriggers, ...afterTriggers]) test(`${label}/${trigger}: phase gate at scheduling and final send`, () => {
    const expected = beforeTriggers.includes(trigger) ? before : after;
    assert.equal(allowsAppointmentAutomation(row, trigger), expected);
    const execution = { trigger_type: trigger, trigger_entity_id: 11, context: { appointment: { inicio: row.inicio } } };
    const invoke = () => assertAppointmentEligibility({ appointment: row, execution, clinicId: 3, patientId: 7, now: +now });
    if (expected) assert.equal(invoke(), true);
    else assert.throws(invoke, { code: 'whatsapp_appointment_care_stage_ineligible' });
  });
}
