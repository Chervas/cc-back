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
test('no-show is unavailable before the exact scheduled instant, including Spain daylight-saving offsets', () => {
  for (const start of ['2026-10-08T11:00:00.000Z', '2026-10-08T13:00:00+02:00', '2026-11-08T12:00:00+01:00']) {
    const row = { ...base, inicio: start };
    const begins = new Date(start), before = new Date(begins.getTime() - 1);
    assert.equal(careState(row, before).can_no_show, false);
    assert.throws(() => assertCareStatusChange(row, { estado: 'no_asistio' }, before), { code: 'care_no_show_too_early' });
    assert.equal(careState(row, begins).can_no_show, true);
    assert.doesNotThrow(() => assertCareStatusChange(row, { estado: 'no_asistio' }, begins));
    assert.doesNotThrow(() => assertCareStatusChange(row, { estado: 'no_asistio' }, new Date(+begins + 1)));
  }
});
test('no-show never replaces actual arrival, started care, completed care or historical attendance', () => {
  for (const row of [arrived, started, completed, { ...arrived, care_legacy_attendance: true }]) {
    assert.equal(careState(row, now).can_no_show, false);
    assert.throws(() => assertCareStatusChange(row, { estado: 'no_asistio' }, now), error => /^care_/.test(error.code));
  }
  assert.throws(() => assertCareStatusChange({ ...base, estado: 'cancelada' }, { estado: 'no_asistio' }, now), { code: 'care_appointment_inactive' });
  assert.equal(careState({ ...base, estado: 'cambio_solicitado' }, now).can_no_show, false);
  assert.throws(() => assertCareStatusChange({ ...base, estado: 'cambio_solicitado' }, { estado: 'no_asistio' }, now), { code: 'care_no_show_state_invalid' });
  for (const inicio of [null, undefined, '', 'not-a-date']) {
    assert.equal(careState({ ...base, inicio }, now).can_no_show, false);
    assert.throws(() => assertCareStatusChange({ ...base, inicio }, { estado: 'no_asistio' }, now), { code: 'care_no_show_start_required' });
  }
});
test('no-show guard applies to generic creation and does not manufacture care evidence or alter confirmation stages', () => {
  assert.throws(() => assertCareStatusChange(null, { ...base, estado: 'no_asistio', inicio: '2026-10-09T11:00:00Z' }, now), { code: 'care_no_show_too_early' });
  for (const estado of ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada']) {
    const row = { ...base, estado, inicio: '2026-10-09T11:00:00Z' };
    assert.doesNotThrow(() => assertCareStatusChange(row, { estado: 'cancelada' }, now));
    assert.doesNotThrow(() => assertCareStatusChange(row, { estado: 'recordatorio_confirmado' }, now));
    assert.equal(careState(row, now).can_no_show, false);
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
      { doctor_id: 99 }, { instalacion_id: 99 },
      { inicio: '2026-10-09T11:00:00Z' }, { fin: '2026-10-08T12:30:00Z' }]) {
      assert.throws(() => assertCareStatusChange(row, change), { code: 'care_reservation_locked' });
    }
    assert.doesNotThrow(() => assertCareStatusChange(row, { nota: 'Reception note' }));
  }
});
test('started/completed/historical resource protection includes actual support IDs, but not documentary names or a mere arrival', () => {
  const support = { version: 1, ids: [12], names: ['Original support'], start_at: base.inicio, end_at: base.fin };
  for (const evidence of [started, completed, { ...arrived, care_legacy_attendance: true }]) {
    const row = { ...evidence, doctor_id: 10, instalacion_id: 20, import_metadata: { additional_staff: support } };
    for (const additionalStaffIds of [[], [13], [12, 13]]) {
      assert.throws(() => assertCareStatusChange(row, { estado: row.estado }, now, { additionalStaffIds }), { code: 'care_reservation_locked' });
    }
    assert.doesNotThrow(() => assertCareStatusChange(row, { doctor_id: '10', instalacion_id: 20 }, now, { additionalStaffIds: [12] }));
    assert.doesNotThrow(() => assertCareStatusChange(row, { nota: 'Documentary note' }, now));
  }
  assert.doesNotThrow(() => assertCareStatusChange(arrived, { doctor_id: 99, instalacion_id: 99 }, now, { additionalStaffIds: [13] }));
  assert.doesNotThrow(() => assertCareStatusChange(base, { doctor_id: 99, instalacion_id: 99 }, now, { additionalStaffIds: [13] }));
});
test('protected phase resources cannot be changed behind unchanged primary doctor/room fields', () => {
  const phases = [{ key: 'one', installation_id: 20, doctor_ids: [10] }, { key: 'two', installation_id: 21, doctor_ids: [11, 12] }];
  const row = { ...started, doctor_id: 10, instalacion_id: 20, import_metadata: { booking: { phases } } };
  for (const second of [{ ...phases[1], installation_id: 22 }, { ...phases[1], doctor_ids: [11, 13] }]) {
    assert.throws(() => assertCareStatusChange(row, { import_metadata: { booking: { phases: [phases[0], second] } } }), { code: 'care_reservation_locked' });
  }
  assert.doesNotThrow(() => assertCareStatusChange(row, { import_metadata: JSON.stringify({ booking: {
    phases: [phases[0], { ...phases[1], label: 'Documentary label', doctor_ids: [12, 11] }],
  } }) }));
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
