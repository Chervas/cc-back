'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../../lib/appointment-reminder-sequence');
const row = (id_cita, inicio, patch = {}) => ({ id_cita, clinica_id: 66, paciente_id: 8,
  inicio, estado: 'pendiente', import_metadata: {}, ...patch });
const first = row(11, '2030-01-03T09:00:00Z');
const scope = c.dayScope(first, 'Europe/Madrid');

test('same patient/clinic/local day identity excludes rooms, templates, namespace, hour and appointment', () => {
  const later = row(12, '2030-01-03T16:00:00Z', { doctor_id: 22, instalacion_id: 23 });
  assert.equal(c.sequenceKey(scope), c.sequenceKey(c.dayScope(later, 'Europe/Madrid')));
  assert.notEqual(c.sequenceKey(scope), c.sequenceKey(c.dayScope({ ...later, clinica_id: 72 }, 'Europe/Madrid')));
  assert.notEqual(c.sequenceKey(scope), c.sequenceKey(c.dayScope({ ...later, paciente_id: 9 }, 'Europe/Madrid')));
  assert.notEqual(c.sequenceKey(scope), c.sequenceKey(c.dayScope(row(13, '2030-01-04T09:00:00Z'), 'Europe/Madrid')));
});

test('first chronological arrival includes unlinked extraction/PRP and confirmed/completed reservations', () => {
  const extraction = row(12, '2030-01-03T08:45:00Z', { estado: 'recordatorio_confirmado', motivo: 'Extracción PRP' });
  assert.equal(c.selectAnchor([first, extraction], scope).id_cita, 12);
  for (const estado of ['info_confirmada', 'completada', 'ha_acudido', 'en_atencion', 'no_asistio']) {
    assert.equal(c.selectAnchor([first, { ...extraction, estado }], scope).id_cita, 12);
  }
  assert.equal(c.selectAnchor([first, { ...extraction, estado: 'cancelada' }], scope).id_cita, 11);
  assert.equal(c.selectAnchor([first, { ...extraction, es_provisional: true }], scope).id_cita, 11);
});

test('same-time ordering deterministic, true scope and no mutation', () => {
  const input = [row(14, first.inicio), row(10, first.inicio), { ...first, clinica_id: 72 }];
  const before = structuredClone(input);
  assert.equal(c.selectAnchor(input, scope).id_cita, 10);
  assert.deepEqual(input, before);
});

test('local date and UTC bounds use clinic timezone including DST, not server date', () => {
  const nearMidnight = c.dayScope(row(11, '2030-01-03T23:30:00Z'), 'Europe/Madrid');
  assert.equal(nearMidnight.local_date, '2030-01-04');
  assert.equal(+nearMidnight.ends_at - +nearMidnight.starts_at, 86400000);
  const shortDay = c.dayScope(row(11, '2030-03-31T09:00:00Z'), 'Europe/Madrid');
  assert.equal(+shortDay.ends_at - +shortDay.starts_at, 23 * 3600000);
  const longDay = c.dayScope(row(11, '2030-10-27T09:00:00Z'), 'Europe/Madrid');
  assert.equal(+longDay.ends_at - +longDay.starts_at, 25 * 3600000);
  assert.throws(() => c.dayScope({ ...first, inicio: '2030-01-03 09:00:00' }, 'Europe/Madrid'), /instant_invalid/);
});

test('reminder/timeout classification never captures acknowledgements or reply text', () => {
  const execution = { trigger_type: 'appointment_reminder_window', context: { trigger: { schedule_moment: 'day_before' } } };
  assert.equal(c.executionStage(execution), 'day_before');
  assert.equal(c.executionStage({ ...execution, context: { trigger: { schedule_moment: 'week_before' } } }), 'week_before');
  assert.equal(c.messageStage({ execution, message: { metadata: { template_name: 'clinicaclick_recordatorio_semana_antes_v2' } } }), 'week_before');
  assert.equal(c.messageStage({ execution, message: { metadata: { template_name: 'clinicaclick_recordatorio_dia_antes_v2' } } }), 'day_before');
  assert.equal(c.messageStage({ execution, message: { metadata: { fallback_template_name: 'clinicaclick_recordatorio_mismo_dia' } } }), 'same_day');
  assert.equal(c.messageStage({ execution, message: { metadata: { appointment_timeout: true } } }), 'no_response');
  assert.equal(c.messageStage({ execution, message: { metadata: { template_name: 'clinicaclick_cita_confirmada' } } }), null);
  assert.equal(c.messageStage({ execution, message: { metadata: { node_type: 'action/reply_message' } } }), null);
  assert.throws(() => c.messageStage({ execution, message: { metadata: { appointment_timeout: true } }, stageKey: 'same_day' }), /stage_changed/);
  const timeout = { ...execution, context: { ...execution.context, whatsapp_no_response_timeout: true } };
  assert.equal(c.messageStage({ execution: timeout, message: { metadata: {} } }), 'no_response');
  assert.equal(c.messageStage({ execution: timeout, message: { metadata: { appointment_timeout: false } } }), null);
  assert.equal(c.messageStage({ execution: timeout, message: { metadata: { appointment_timeout: false,
    template_name: 'clinicaclick_recordatorio_dia_antes' } } }), 'day_before');
  assert.throws(() => c.messageStage({ execution: timeout, message: { metadata: { template_name: 'clinicaclick_recordatorio_mismo_dia' } }, stageKey: 'same_day' }), /stage_changed/);
  assert.equal(c.messageStage({ execution: { ...timeout, context: { ...timeout.context, whatsapp_no_response_timeout: false } },
    message: { metadata: { template_name: 'clinicaclick_cita_confirmada' } } }), null);
});

test('accepted/read receipts with null sent_at and unknown sending attempts remain sticky', () => {
  for (const status of ['sending', 'sent', 'delivered', 'read']) assert.equal(c.everAttempted({ status, sent_at: null }), true);
  assert.equal(c.everAttempted({ status: 'failed', metadata: { delivery_unknown: true } }), true);
  assert.equal(c.everAttempted({ status: 'pending', metadata: {} }), false);
  assert.equal(c.everAttempted({ status: 'failed', metadata: { provider_acceptance_at: '2030-01-02T08:00:00Z' } }), true);
});

test('claim evidence validates stage identity and clones without relaxing malformed records', () => {
  const input = { day_before: { execution_id: 7, appointment_id: 11, claimed_at: '2030-01-01T10:00:00Z', message_id: 6, attempted: true } };
  const normalized = c.claims(input);
  normalized.day_before.message_id = 8;
  assert.equal(input.day_before.message_id, 6);
  assert.throws(() => c.claims({ another: input.day_before }), /ledger_corrupt/);
  assert.throws(() => c.claims({ no_response: { ...input.day_before, execution_id: 0 } }), /ledger_corrupt/);
  assert.throws(() => c.claims({ no_response: { ...input.day_before, attempted: 'false' } }), /ledger_corrupt/);
  for (const malformed of [null, [], 'not-json', '"string"', 'null']) assert.throws(() => c.claims(malformed), /ledger_corrupt/);
});

test('every historical-placeholder representation is excluded without excluding operational import HOLD', () => {
  const earlier = row(12, '2030-01-03T08:00:00Z');
  for (const patch of [{ import_metadata: { historical_registration: 1 } }, { import_metadata: { imported_as_past_activity: 'true' } },
    { source_system: 'lead_resolution_historical' }, { source_system: 'clinicaclick_reactivation_import' },
    { tipo_cita: 'historico_importado' }, { titulo: 'Histórico: actividad' }, { motivo: 'Importación de pacientes para reactivación' }]) {
    assert.equal(c.selectAnchor([first, { ...earlier, ...patch }], scope).id_cita, 11, JSON.stringify(patch));
  }
  const operational = { ...earlier, source_system: 'cliniccloud', import_metadata: { automation_policy: 'hold' } };
  assert.equal(c.selectAnchor([first, operational], scope).id_cita, 12);
});
