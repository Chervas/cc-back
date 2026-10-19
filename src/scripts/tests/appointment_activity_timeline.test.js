'use strict';

const assert = require('assert');
const {
  APPOINTMENT_STATUS_EVENT_TYPE,
  appointmentStatusLabel,
  serializeAppointmentStatusActivity,
} = require('../../services/appointmentActivity.service');

function run() {
  assert.strictEqual(APPOINTMENT_STATUS_EVENT_TYPE, 'appointment.status_changed');
  assert.strictEqual(appointmentStatusLabel('info_confirmada'), 'Datos de la cita confirmados');
  assert.strictEqual(appointmentStatusLabel('recordatorio_confirmado'), 'Cita confirmada');

  const item = serializeAppointmentStatusActivity({
    id: 99,
    source: 'automation_v2',
    actor_user_id: null,
    occurred_at: '2026-07-31T10:29:38.000Z',
    metadata: {
      appointment_id: 74576,
      previous_status: 'info_enviada',
      new_status: 'info_confirmada',
      flow_name: 'Envío de datos de la cita tras agendar',
    },
  }, { patientId: 32202 });

  assert.strictEqual(item.tipo, 'appointment_confirmed');
  assert.strictEqual(item.titulo, 'Datos de la cita confirmados');
  assert.match(item.descripcion, /Automatización «Envío de datos de la cita tras agendar»/);
  assert.match(item.descripcion, /Datos de la cita enviados → Datos de la cita confirmados/);
  assert.strictEqual(item.citaId, '74576');
  assert.strictEqual(item.usuarioNombre, 'Sistema');

  const reminder = serializeAppointmentStatusActivity({
    id: 100,
    source: 'automation_v2',
    occurred_at: '2026-08-03T07:11:13.000Z',
    metadata: {
      appointment_id: 74576,
      previous_status: 'recordatorio_enviado',
      new_status: 'recordatorio_confirmado',
      flow_name: 'Recordatorio de cita del día anterior',
    },
  }, { leadId: 7408 });

  assert.strictEqual(reminder.tipo, 'appointment_confirmed');
  assert.strictEqual(reminder.titulo, 'Cita confirmada por el paciente');
  assert.strictEqual(reminder.leadId, '7408');

  const cards = [12, 13, 14].map((id, index) => serializeAppointmentStatusActivity({
    id, event_type: APPOINTMENT_STATUS_EVENT_TYPE, source: 'agenda', occurred_at: '2026-10-19T14:04:00Z',
    metadata: { appointment_id: id, previous_status: 'recordatorio_confirmado', new_status: 'no_asistio' },
  }, { appointment: { inicio: `2026-10-19 1${index}:00:00` } }));
  assert.equal(new Set(cards.map(card => card.id)).size, 3);
  assert.equal(new Set(cards.map(card => card.descripcion)).size, 3);
  assert.match(cards[0].descripcion, /19\/10\/2026, 12:00.*#12/);
  const frozen = serializeAppointmentStatusActivity({ id: 1, metadata: {
    appointment_id: 12, appointment_start: '2026-10-19T10:00:00Z', new_status: 'no_asistio',
  } }, { appointment: { inicio: '2026-10-30T14:00:00Z' } });
  assert.match(frozen.descripcion, /19\/10\/2026, 12:00/);
  assert.doesNotMatch(frozen.descripcion, /30\/10/);

  console.log('appointment_activity_timeline.test.js OK');
}

run();
