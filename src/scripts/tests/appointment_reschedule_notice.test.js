'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessment, suppressRescheduleNotice, checkRescheduleNotice } = require('../../lib/appointment-reschedule-notice');
const previous = { id_cita: 1, paciente_id: 2, clinica_id: 3, inicio: '2026-11-10T16:30:00Z', fin: '2026-11-10T17:00:00Z' };
const values = { ...previous, inicio: '2026-11-11T16:30:00Z', fin: '2026-11-11T17:00:00Z', reschedule_reason: 'patient_request' };
const messages = [{ id: 1, appointment_id: 10, template_name: 'clinicaclick_cita_reprogramada_peticion_paciente_v15', sent_at: '2026-10-19 11:05:00' }];
const input = { previous, values, actorId: 4, messages, now: new Date('2026-10-19T13:00:00Z'), clinic: { configuracion: { timezone: 'Europe/Madrid' } } };
function warning(value = input) {
  try { assessment(value); assert.fail('Expected explicit notice choice'); }
  catch (error) { assert.equal(error.code, 'appointment_notice_already_sent_today'); return error.details; }
}
test('a notice for a different future appointment warns, with clinic-local date and an exact acknowledgement', () => {
  const details = warning();
  assert.equal(details.appointment_id, 10); assert.equal(details.last_notice_at, '2026-10-19T11:05:00.000Z');
  for (const send of [true, false]) {
    const receipt = assessment({ ...input, decision: { acknowledgement: details.acknowledgement, send } });
    assert.equal(receipt.send, send); assert.equal(receipt.actor_id, 4);
    assert.equal(suppressRescheduleNotice({ ...values, import_metadata: { reschedule_notice: receipt } }), !send);
    assert.equal(suppressRescheduleNotice({ ...values, paciente_id: 9, import_metadata: { reschedule_notice: receipt } }), false);
    assert.equal(suppressRescheduleNotice({ ...values, inicio: previous.inicio, import_metadata: { reschedule_notice: receipt } }), false);
  }
});
test('same-time resource changes and administrative corrections do not query notices or prompt', async () => {
  for (const target of [{ ...values, inicio: previous.inicio, fin: previous.fin }, { ...values, reschedule_reason: 'administrative_error' }]) {
    assert.equal(await checkRescheduleNotice({ ...input, values: target,
      db: { sequelize: { query() { assert.fail('No notice query'); } } } }), null);
  }
});
test('acknowledgements cannot survive another actor, date, range, previous reservation or a new notice', () => {
  const details = warning();
  for (const changes of [{ actorId: 5 }, { now: new Date('2026-10-20T13:00:00Z'), messages: [{ ...messages[0], sent_at: '2026-10-20 10:00:00' }] },
    { values: { ...values, fin: '2026-11-11T18:00:00Z' } },
    { previous: { ...previous, inicio: '2026-11-10T15:00:00Z' } }, { messages: [...messages, { ...messages[0], id: 2 }] }]) {
    warning({ ...input, ...changes, decision: { acknowledgement: details.acknowledgement, send: true } });
  }
});
test('yesterday, silence follow-ups and non-appointment messages do not create a false warning', () => {
  for (const message of [{ ...messages[0], sent_at: '2026-10-18 11:00:00' },
    { ...messages[0], template_name: 'clinicaclick_confirmacion_datos_cita_48_sin_respuesta_v10' },
    { ...messages[0], template_name: 'other_template' }]) assert.equal(assessment({ ...input, messages: [message] }), null);
});
test('date boundaries follow clinic daylight-saving rules, not the server UTC day', () => {
  for (const hour of [0,1,2,3,8,12,18,22,23]) for (const day of ['2026-01-12','2026-03-29','2026-10-25','2026-12-12']) {
    const now = new Date(`${day}T${String(hour).padStart(2,'0')}:30:00Z`);
    const row = { ...messages[0], sent_at: now.toISOString() };
    const details = warning({ ...input, now, messages: [row] });
    assert.equal(details.notice_count,1);
  }
});
test('programme warning includes previous programme summaries and binds the full batch, revision and reason', () => {
  const operationContext = { voucher_id: 10, revision: 'old', reason: 'clinic_schedule', sessions: [{ id: 1, start: values.inicio }, { id: 2, start: values.inicio }] };
  const programme = { ...input, operationContext, messages: [{ ...messages[0], template_name: 'clinicaclick_citas_programa_reservadas' }] };
  const details = warning(programme), decision = { acknowledgement: details.acknowledgement, send: false };
  assert.equal(assessment({ ...programme, decision }).send, false);
  for (const change of [{ ...operationContext, revision: 'new' }, { ...operationContext, reason: 'patient_request' },
    { ...operationContext, sessions: operationContext.sessions.slice(0, 1) },
    { ...operationContext, sessions: [{ id: 1, start: values.inicio }, { id: 2, start: previous.inicio }] }]) {
    warning({ ...programme, operationContext: change, decision });
  }
});
