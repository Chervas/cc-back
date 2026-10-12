'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const policy = require('../../lib/appointment-reschedule-reason');
const source = fs.readFileSync(require.resolve('../../services/flowEngineV2.service'), 'utf8');
const start = source.indexOf('async function handleChangeStatus(');
const end = source.indexOf('\nasync function handleUpdateLeadInfo(', start);
assert(start >= 0 && end > start);

function fixture(status) {
  const updates = [], events = [], activity = [];
  const appointment = { id_cita: 101, clinica_id: 72, paciente_id: 20, estado: status,
    async update(values) { updates.push(values); Object.assign(this, values); return this; },
    toJSON() { return { id_cita: this.id_cita, clinica_id: this.clinica_id, paciente_id: this.paciente_id, estado: this.estado }; } };
  const s = {
    require(name) {
      if (name === '../lib/appointment-reschedule-reason') return policy;
      if (name === './appointmentPatientLinks.service') return { load: async () => null, confirmTogether: async () => [] };
      if (name === './treatmentBookingProfile.service') return { bookingCapabilities: () => ({ simple: true }) };
      if (name === './appointmentBookingCommand.service') return { mutateAppointmentBooking: async opts =>
        opts.persist({ existing: appointment, values: opts.appointmentValues, transaction: opts.transaction }) };
      throw Error('Unexpected offline flow dependency: ' + name);
    },
    db: { sequelize: { transaction: async (_, work) => work({ LOCK: { UPDATE: 'UPDATE' } }) } },
    CitaPaciente: { findByPk: async () => appointment },
    cleanString: v => typeof v === 'string' ? v.trim() : '', toIntOrNull: v => Number(v) > 0 ? Number(v) : null,
    resolveRuntimeTargets: () => ({ appointment_id: 101 }), backfillRuntimeTargets: async (_, targets) => targets,
    resolveTemplateValue: value => value, normalizeCitaStatus: value => value, normalizeLeadStatus: () => null,
    normalizeStatusTarget: value => value, readOutputTarget: (node, key) => node.outputs[key],
    PROTECTED_APPOINTMENT_STATUSES: new Set(['cancelada', 'no_asistio', 'ha_acudido', 'en_atencion', 'completada']),
    APPOINTMENT_NOTIFICATION_RESOLVED_STATUSES: new Set(['info_confirmada', 'recordatorio_confirmado']),
    appointmentNotificationCleanup: { markAutomationNotificationsReadForAppointment: async () => {} },
    recordAppointmentStatusChange: async record => activity.push(record),
    emitAppointmentSocketEvent: row => events.push(row.toJSON()),
    isAppointmentIntentResolvedByConcurrentChange: () => false,
  };
  vm.createContext(s); vm.runInContext(source.slice(start, end), s);
  return { appointment, updates, events, activity, async run({ reason = 'administrative_error', trigger = 'appointment_rescheduled',
    next = 'info_confirmada', captured = status } = {}) {
    const context = { trigger: { type: trigger, data: { reschedule_reason: reason } }, appointment: { estado: captured } };
    const result = await s.handleChangeStatus({ config: { new_status: next, target_entity: 'appointment' }, outputs: { on_success: null } },
      context, { execution: { trigger_type: trigger, created_by: 7 } });
    return { result, context };
  } };
}

test('old administrative status node cannot revoke persisted attendance confirmation, including stale captured status', async () => {
  const f = fixture('recordatorio_confirmado'), { result, context } = await f.run({ captured: 'info_enviada' });
  assert.equal(f.appointment.estado, 'recordatorio_confirmado');
  assert.equal(result.output.new_status, 'recordatorio_confirmado');
  assert.equal(context.appointment.estado, 'recordatorio_confirmado');
  assert.equal(f.updates.length, 0); assert.equal(f.activity.length, 0);
  assert.equal(f.events.length, 1); assert.equal(f.events[0].estado, 'recordatorio_confirmado');
});

test('administrative correction still confirms initial details when attendance was not confirmed', async () => {
  const f = fixture('recordatorio_enviado'), { result } = await f.run();
  assert.equal(f.appointment.estado, 'info_confirmada'); assert.equal(result.output.new_status, 'info_confirmada');
  assert.equal(f.updates.length, 1); assert.equal(f.activity.length, 1);
});

test('administrative reason on an unrelated reminder event is not a silent-reschedule override', async () => {
  const f = fixture('info_enviada'), { result } = await f.run({ trigger: 'appointment_reminder_window', next: 'recordatorio_confirmado' });
  assert.equal(f.appointment.estado, 'recordatorio_confirmado'); assert.equal(result.output.new_status, 'recordatorio_confirmado');
  assert.equal(f.updates.length, 1);
});

for (const status of ['cancelada', 'no_asistio', 'ha_acudido', 'en_atencion', 'completada'])
  test('administrative status node retains protected lifecycle: ' + status, async () => {
    const f = fixture(status), { result } = await f.run();
    assert.equal(f.appointment.estado, status); assert.equal(f.updates.length, 0);
    assert.equal(result.output.reason, 'appointment_status_protected'); assert.equal(f.events.length, 0);
  });

test('only stored attendance confirmation, not a requested value, is preserved by the policy', () => {
  for (const current of ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'reprogramada', undefined, null]) {
    assert.equal(policy.statusForReschedule('administrative_error', 'recordatorio_confirmado', current), 'info_confirmada');
  }
  for (const reason of ['patient_request', 'clinic_schedule']) {
    assert.equal(policy.statusForReschedule(reason, 'reprogramada', 'recordatorio_confirmado'), 'reprogramada');
  }
});
