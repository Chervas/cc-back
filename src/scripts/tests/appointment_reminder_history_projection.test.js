'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const classification = require('../../lib/appointment-reminder-sequence');
const filename = require.resolve('../../services/appointmentReminderSequence.service');
const source = fs.readFileSync(filename, 'utf8');
const api = 'return Object.freeze({ inspectAppointment, claimExecution, authorizeMessage });';
assert.equal(source.split(api).length, 2);

// Expose only the private read projection in this isolated VM. No app models,
// live database, transaction mutation, worker or provider can be loaded here.
async function projection({ status = 'pending', waResponse = 0, wamid = null } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source.replace(api, 'return Object.freeze({ priorHistory });'), {
    module, exports: module.exports, require: createRequire(filename),
  }, { filename });
  const db = { Sequelize: { Op: {} }, CitaPaciente: {}, Clinica: {},
    AppointmentReminderSequence: {}, FlowExecutionV2: {}, Message: {},
    sequelize: { query: async sql => {
      assert.match(sql, /JSON_TYPE\(JSON_EXTRACT\(m.metadata,'\$\.wa_response'\)\)<>'NULL'/);
      return [[{ execution_id: 20, appointment_id: 10, context_patient_id: '30',
        start_at: '2026-10-15T07:30:00.000Z', message_id: 40, status, sent_at: null,
        appointment_timeout: 'false', context_timeout: 'true',
        template_name: 'clinicaclick_recordatorio_dia_antes_es', wa_response: waResponse, wamid }]];
    } },
  };
  const service = module.exports.createAppointmentReminderSequenceService({ db });
  return service.priorHistory({ appointments: [{ id_cita: 10 }], scope: {
    clinic_id: 66, patient_id: 30, local_date: '2026-10-15', time_zone: 'Europe/Madrid',
    starts_at: new Date('2026-10-14T22:00:00.000Z'), ends_at: new Date('2026-10-15T22:00:00.000Z'),
  } }, null);
}

test('SQL zero response predicate never seals pending or definitely rejected unattempted history', async () => {
  for (const status of ['pending', 'failed']) {
    const [row] = await projection({ status, waResponse: 0 });
    assert.equal(row.metadata.wa_response, false);
    assert.equal(classification.everAttempted(row), false);
    assert.equal(row.stage, 'day_before'); // Immutable false timeout snapshot.
  }
});

test('actual provider responses, sending, accepted and uncertain receipts remain sticky', async () => {
  for (const input of [{ waResponse: 1 }, { waResponse: '1' }, { status: 'sending' },
    { status: 'sent' }, { status: 'delivered' }, { status: 'read' }, { wamid: '"wamid.accepted"' }]) {
    const [row] = await projection(input);
    assert.equal(classification.everAttempted(row), true);
  }
});
