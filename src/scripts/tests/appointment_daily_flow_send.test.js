'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const classifier = require('../../lib/appointment-reminder-sequence');

// Execute the actual guard before outbound Message materialization. Deliberately
// no application bootstrap, models, environment, worker or provider is loaded.
const source = fs.readFileSync(require.resolve('../../services/flowEngineV2.service'), 'utf8');
const from = source.indexOf('  const dailyStage = require(\'../lib/appointment-reminder-sequence\').messageStage({');
const to = source.indexOf('  const senderClinic = await Clinica.findByPk', from);
assert.ok(from > 0 && to > from);
const code = `(async () => { ${source.slice(from, to)} return { continued: true }; })()`;

async function run({ name = 'clinicaclick_recordatorio_mismo_dia_es', timeout = false,
  follower = false, confirmed = false, allowed = true } = {}) {
  const calls = [];
  const appointment = { id_cita: 10 };
  const sequence = {
    inspectAppointment: async input => {
      assert.equal(input.appointment, appointment); calls.push('inspect');
      return { follower, attendanceConfirmed: confirmed,
        reason: follower ? 'appointment_day_uses_first_arrival' : null };
    },
    claimExecution: async input => {
      calls.push('claim'); assert.equal(input.appointment, appointment);
      assert.equal(input.executionId, 20);
      assert.equal(input.scheduleMoment, name.includes('dia_antes') ? 'day_before' : 'same_day');
      return { allowed, reason: allowed ? null : 'appointment_day_stage_already_owned' };
    },
  };
  const result = await vm.runInNewContext(code, {
    require: name => {
      if (name === '../lib/appointment-reminder-sequence') return classifier;
      if (name === './appointmentReminderSequence.service') return { current: () => sequence };
      throw Error('unexpected_dependency');
    },
    template: { name }, fallbackTriggeredReason: null,
    context: { whatsapp_no_response_timeout: timeout },
    execution: { id: 20, trigger_entity_type: 'appointment', trigger_entity_id: 10 },
    CitaPaciente: { findByPk: async id => { assert.equal(id, 10); return appointment; } },
  });
  return { result, calls };
}

test('unlinked later booking exits the real send node before materializing a Message or its wait chain', async () => {
  const { result, calls } = await run({ follower: true });
  assert.equal(result.output.status, 'suppressed_patient_day_reminder');
  assert.equal(result.next_node_id, null);
  assert.deepEqual(calls, ['inspect']);
});

test('first arrival continues only with the durable stage owner; a competing flow cannot open a second wait', async () => {
  assert.equal((await run()).result.continued, true);
  const { result, calls } = await run({ name: 'clinicaclick_recordatorio_dia_antes_es', allowed: false });
  assert.equal(result.output.reason, 'appointment_day_stage_already_owned');
  assert.equal(result.next_node_id, null);
  assert.deepEqual(calls, ['inspect', 'claim']);
});

test('no-response followers and a confirmed day exit before send; unconfirmed owner retains final atomic dispatch check', async () => {
  for (const input of [{ follower: true }, { confirmed: true }]) {
    const { result, calls } = await run({ ...input, name: 'followup_text', timeout: true });
    assert.equal(result.next_node_id, null); assert.deepEqual(calls, ['inspect']);
  }
  const { result, calls } = await run({ name: 'followup_text', timeout: true });
  assert.equal(result.continued, true); assert.deepEqual(calls, ['inspect']);
});

test('reply acknowledgements and independent clinical templates do not acquire reminder rights', async () => {
  for (const name of ['clinicaclick_cita_confirmada_es', 'clinicaclick_cita_cancelada_es', 'clinicaclick_consentimiento_es']) {
    const { result, calls } = await run({ name });
    assert.equal(result.continued, true); assert.deepEqual(calls, []);
  }
});
