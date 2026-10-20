'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const C = require('../../lib/patient-program-booking-notice');

function fixture(count = 10) {
  return {
    voucher: { id: 27, public_id: 'voucher-fixture-27', clinic_id: 66, patient_id: 123, source_system: 'treatment_program' },
    receipt: { id: 987, voucher_id: 27, request_key: 'fictitious_request_987', request_sha256: 'a'.repeat(64), created_by: 7,
      result: { voucher_id: 'voucher-fixture-27', reminders_enabled: false, replayed: false,
        sessions: Array.from({ length: count }, (_, index) => ({ key: `session-${index + 1}`,
          appointment_id: index + 1000, action: 'created',
          start_at: new Date(Date.UTC(2027, 0, 4 + index * 15, 8)).toISOString(),
          end_at: new Date(Date.UTC(2027, 0, 4 + index * 15, 8, 45)).toISOString(),
          phases: [{ clinical_notes: 'Never copy this', doctor_id: 2 }],
        })) } },
    snapshot: { sha256: 'b'.repeat(64), name: 'Confidential programme title', appointments: Array.from({ length: count }, (_, index) => ({ key: `session-${index + 1}`, clinical_notes: 'Never copy' })) },
    clinic: { id_clinica: 66, nombre_clinica: 'Clínica ficticia', configuration: { not_for_transport: true } },
    actorId: 7, timeZone: 'Europe/Madrid', communicationLanguage: 'es_ES', occurredAt: '2026-10-20T12:00:00.000Z',
  };
}
const prepare = input => C.prepareCommittedBooking(input || fixture());

test('committed programme receipt produces minimal scoped data, real numbering and clinic civil dates', () => {
  const input = fixture();
  input.receipt.result.sessions = [input.receipt.result.sessions[6], input.receipt.result.sessions[2]];
  const output = prepare(input);
  assert.equal(output.clinic_id, 66); assert.equal(output.patient_id, 123); assert.equal(output.actor_user_id, 7);
  assert.equal(output.booking_receipt_id, 987); assert.equal(output.program_session_count, 10); assert.equal(output.appointment_count, 2);
  assert.deepEqual(output.appointments.map(row => row.number), [3, 7]);
  assert.equal(output.appointments[0].local_date, '03/02/2027');
  assert.equal(output.appointments[0].local_time, '09:00');
  assert.match(output.preview.parameters[2], /^3\/10\) 03\/02\/2027 09:00; 7\/10\) /);
  assert.equal(output.preview.parameters[1], '2');
  for (const prohibited of ['Confidential', 'Never copy', 'clinical_notes', 'doctor_id', 'configuration', 'phone', 'email']) {
    assert.equal(JSON.stringify(output).includes(prohibited), false, prohibited);
  }
  assert.deepEqual(input, Object.assign(fixture(), { receipt: input.receipt }));
});

test('every one of thirty appointments fits one conservative complete body in all prepared languages', () => {
  for (const locale of ['es', 'ca', 'en']) {
    const input = fixture(30); input.communicationLanguage = locale; input.clinic.nombre_clinica = 'C'.repeat(80);
    const output = prepare(input);
    assert.equal(output.appointments.length, 30);
    assert(output.preview.body_characters <= 1024, `${locale}: ${output.preview.body_characters}`);
    assert.match(output.preview.parameters[2], /30\/30\)/);
    assert.equal(output.preview.parameters[2].split('; ').length, 30);
    assert.equal(/[\r\n\t\u2028\u2029]| {5}/.test(output.preview.parameters.join('')), false);
    assert.equal(output.preview.body.includes('{{'), false);
  }
});

test('clinic time zone, not browser/server zone, determines civil date and DST', () => {
  const input = fixture(2);
  input.receipt.result.sessions[0].start_at = '2026-10-24T22:30:00.000Z';
  input.receipt.result.sessions[0].end_at = '2026-10-24T23:15:00.000Z';
  input.receipt.result.sessions[1].start_at = '2026-10-25T22:30:00.000Z';
  input.receipt.result.sessions[1].end_at = '2026-10-25T23:15:00.000Z';
  const madrid = prepare(input);
  assert.deepEqual(madrid.appointments.map(row => [row.local_date, row.local_time]), [['25/10/2026', '00:30'], ['25/10/2026', '23:30']]);
  input.timeZone = 'America/New_York';
  assert.deepEqual(prepare(input).appointments.map(row => [row.local_date, row.local_time]), [['24/10/2026', '18:30'], ['25/10/2026', '18:30']]);
});

test('duplicate local DST hours keep exact UTC identity instead of collapsing appointments', () => {
  const input = fixture(2);
  input.receipt.result.sessions[0].start_at = '2026-10-25T00:15:00.000Z';
  input.receipt.result.sessions[0].end_at = '2026-10-25T00:30:00.000Z';
  input.receipt.result.sessions[1].start_at = '2026-10-25T01:15:00.000Z';
  input.receipt.result.sessions[1].end_at = '2026-10-25T01:30:00.000Z';
  const output = prepare(input);
  assert.equal(output.appointments.length, 2);
  assert.deepEqual(output.appointments.map(row => row.local_time), ['02:15', '02:15']);
  assert.notEqual(output.appointments[0].start_at, output.appointments[1].start_at);
});

test('preparation refuses missing clinic time zone or language, with no global Madrid/language fallback', () => {
  for (const timeZone of [undefined, null, '', ' ', 'Europe/NotAClinic', ' Europe/Madrid']) {
    assert.throws(() => prepare({ ...fixture(), timeZone }), /program_notice_timezone/);
  }
  for (const communicationLanguage of [undefined, null, '', 'fr', 'es-anything', true]) {
    assert.throws(() => prepare({ ...fixture(), communicationLanguage }), /program_notice_language/);
  }
  assert.equal(prepare({ ...fixture(), communicationLanguage: 'ca_ES' }).language, 'ca');
  assert.equal(prepare({ ...fixture(), communicationLanguage: 'en-US' }).language, 'en');
});

test('identical receipt and canonical programme produce stable fingerprints and idempotency keys', () => {
  const input = fixture();
  const first = C.eventPreparation(input), second = C.eventPreparation(structuredClone(input));
  assert.deepEqual(first, second);
  assert.equal(first.event_type, 'patient.program_appointments_booked');
  assert.equal(first.execution_idempotency_key, 'patient.program_appointments_booked:66:987');
  assert.equal(first.message_idempotency_key, 'program-booking-notice:66:987:outbound');
  input.receipt.result.sessions.reverse();
  assert.equal(C.eventPreparation(input).metadata.snapshot_sha256, first.metadata.snapshot_sha256);
  input.receipt.id++;
  assert.notEqual(C.eventPreparation(input).metadata.snapshot_sha256, first.metadata.snapshot_sha256);
});

test('changing a reservation changes the fingerprint, not the receipt/message dedupe identity', () => {
  const input = fixture(), previous = C.eventPreparation(input);
  input.receipt.result.sessions[0].start_at = '2027-01-04T09:00:00.000Z';
  input.receipt.result.sessions[0].end_at = '2027-01-04T09:45:00.000Z';
  const changed = C.eventPreparation(input);
  assert.notEqual(changed.metadata.snapshot_sha256, previous.metadata.snapshot_sha256);
  assert.equal(changed.message_idempotency_key, previous.message_idempotency_key);
  // The future hook/transport must reject this mismatch, never resend it under
  // the receipt's old identity or silently edit an already-sent body.
});

test('prepareCommittedBooking supports model/plain JSON without mutation', () => {
  const input = fixture(), original = structuredClone(input);
  input.receipt.result = JSON.stringify(input.receipt.result);
  input.voucher = { toJSON: () => original.voucher };
  const payload = prepare(input);
  assert.equal(payload.voucher_id, 27);
  assert.equal(typeof input.receipt.result, 'string');
  assert.deepEqual(original, fixture());
});

test('replay flag, enabled reminders and missing committed receipt do not become new notice requests', () => {
  for (const result of [{ replayed: true }, { replayed: undefined }, { reminders_enabled: true }, { reminders_enabled: undefined }, { voucher_id: 'foreign' }]) {
    const input = fixture(); Object.assign(input.receipt.result, result);
    assert.throws(() => prepare(input), { code: 'program_notice_receipt_invalid' });
  }
  assert.throws(() => prepare({ ...fixture(), receipt: undefined }), { code: 'program_notice_scope_invalid' });
});

for (const [label, change] of [
  ['foreign clinic', input => input.clinic.id_clinica = 72],
  ['foreign voucher', input => input.receipt.voucher_id = 28],
  ['foreign actor', input => input.actorId = 8],
  ['historical purchase', input => input.voucher.source_system = 'cliniccloud'],
  ['no patient', input => input.voucher.patient_id = null],
  ['unsafe receipt ID', input => input.receipt.id = Number.MAX_SAFE_INTEGER + 1],
  ['boolean actor ID', input => input.actorId = true],
]) test(`canonical source scope rejects ${label}`, () => {
  const input = fixture(); change(input);
  assert.throws(() => prepare(input), { code: 'program_notice_scope_invalid' });
});

for (const [label, change] of [
  ['invalid request key', input => input.receipt.request_key = 'short'],
  ['invalid request fingerprint', input => input.receipt.request_sha256 = 'forged'],
  ['missing purchase fingerprint', input => input.snapshot.sha256 = undefined],
]) test(`receipt provenance rejects ${label}`, () => {
  const input = fixture(); change(input);
  assert.throws(() => prepare(input), { code: 'program_notice_receipt_invalid' });
});

for (const [label, change, code] of [
  ['empty batch', input => input.receipt.result.sessions = [], 'program_notice_batch_invalid'],
  ['31 appointments', input => input.receipt.result.sessions.push(...input.receipt.result.sessions, ...input.receipt.result.sessions, input.receipt.result.sessions[0]), 'program_notice_batch_invalid'],
  ['duplicate appointment', input => input.receipt.result.sessions[1].appointment_id = input.receipt.result.sessions[0].appointment_id, 'program_notice_appointment_order_invalid'],
  ['duplicate session', input => input.receipt.result.sessions[1].key = input.receipt.result.sessions[0].key, 'program_notice_appointment_order_invalid'],
  ['foreign session', input => input.receipt.result.sessions[0].key = 'foreign-session', 'program_notice_appointment_invalid'],
  ['linked history', input => input.receipt.result.sessions[0].action = 'linked', 'program_notice_appointment_invalid'],
  ['local naive date', input => input.receipt.result.sessions[0].start_at = '2027-01-04T09:00:00', 'program_notice_appointment_date_invalid'],
  ['impossible civil date', input => input.receipt.result.sessions[0].start_at = '2027-02-30T09:00:00.000Z', 'program_notice_appointment_date_invalid'],
  ['past appointment', input => input.receipt.result.sessions[0].start_at = '2026-10-19T09:00:00.000Z', 'program_notice_appointment_date_invalid'],
  ['negative interval', input => input.receipt.result.sessions[0].end_at = '2027-01-04T07:00:00.000Z', 'program_notice_appointment_date_invalid'],
  ['programme chronology reversal', input => Object.assign(input.receipt.result.sessions[1], { start_at: '2027-01-03T08:00:00.000Z', end_at: '2027-01-03T08:45:00.000Z' }), 'program_notice_appointment_order_invalid'],
]) test(`batch integrity rejects ${label}`, () => {
  const input = fixture(); change(input);
  assert.throws(() => prepare(input), { code });
});

test('invalid programme definitions cannot fabricate numbering or totals', () => {
  for (const appointments of [[], undefined, Array(31).fill({ key: 'a' }), [{ key: 'same' }, { key: 'same' }], [{ key: '' }]]) {
    assert.throws(() => prepare({ ...fixture(), snapshot: { ...fixture().snapshot, appointments } }), { code: 'program_notice_snapshot_invalid' });
  }
});

test('parameter controls reject multiline, template injection, unbounded labels instead of silently dropping visits', () => {
  for (const name of ['Clinic\nOther', 'Clinic\tOther', 'Clinic     Other', 'Clinic{{2}}', 'C'.repeat(81), '']) {
    const input = fixture(); input.clinic.nombre_clinica = name;
    assert.throws(() => prepare(input), { code: 'program_notice_clinic_name_invalid' });
  }
});

test('preparation is always fail-closed: neither flags nor a patient HOLD authorize sending', () => {
  const input = fixture(); input.voucher.import_metadata = { automation_policy: 'hold' };
  const output = prepare(input);
  assert.deepEqual(output.delivery, C.deliveryReadiness());
  assert.equal(output.delivery.can_send, false); assert.equal(output.delivery.sent, false); assert.equal(output.delivery.requested, false);
  assert.equal(output.delivery.hold_unchanged, true); assert.equal(output.delivery.blockers.length, 4);
  assert.equal(C.deliveryReadiness({ approved: true, enabled: true }).can_send, false);
  assert.equal(input.voucher.import_metadata.automation_policy, 'hold');
});

test('all catalogue proposals are unpublished/inactive and reuse only existing action nodes', () => {
  for (const locale of ['es', 'ca', 'en']) {
    const proposal = C.catalogPreparation(locale);
    assert.equal(proposal.can_install, false); assert.equal(proposal.preparation_only, true);
    assert.equal(proposal.whatsapp.category, 'UTILITY'); assert.equal(proposal.whatsapp.is_active, false);
    assert.equal(Object.hasOwn(proposal.whatsapp, 'status'), false); // Never invent a Meta approval.
    assert.equal(proposal.whatsapp.components.length, 1); assert.equal(proposal.whatsapp.variables.length, 3);
    assert(proposal.whatsapp.components[0].text.length <= 1024);
    assert.equal(proposal.flow.is_active, false); assert.equal(proposal.flow.published_at, null);
    assert.equal(proposal.flow.trigger_config.enabled_after, null);
    assert.deepEqual(proposal.flow.nodes.map(node => node.type), [
      `trigger/${C.EVENT}`, 'action/send_whatsapp', 'action/send_system_notification', 'control/end',
    ]);
    assert.deepEqual(proposal.flow.nodes[1].outputs, { on_success: 'N4', on_fail: 'N3' });
    assert.equal(proposal.flow.nodes[1].config.communication_scope, 'care');
    assert.equal(proposal.flow.nodes.some(node => node.type === 'action/change_status'), false);
    assert.equal(proposal.flow.nodes.some(node => node.type === 'delay/wait_response'), false);
    assert.equal(JSON.stringify(proposal.flow).includes('recordatorio_confirmado'), false);
  }
});

test('pure preparation source does not load models, environment, credentials, jobs or provider services', () => {
  const source = fs.readFileSync(require.resolve('../../lib/patient-program-booking-notice'), 'utf8');
  const dependencies = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  assert.deepEqual(dependencies, ['node:crypto']);
  assert.equal(/process\.env|fetch\s*\(|https\.request|enqueueJob|\.create\(/.test(source), false);
});
