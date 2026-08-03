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
  assert.strictEqual(appointmentStatusLabel('recordatorio_confirmado'), 'Asistencia confirmada');

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
  assert.strictEqual(reminder.titulo, 'Asistencia confirmada por el paciente');
  assert.strictEqual(reminder.leadId, '7408');

  console.log('appointment_activity_timeline.test.js OK');
}

run();
