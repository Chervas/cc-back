'use strict';

// Offline only. Reuse the canonical-writer synthetic purchase fixture without
// registering its tests. Its DB models, locks and transactions are in memory;
// neither models/index nor credentials, providers or real databases are loaded.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const fixtureFile = require.resolve('./program_selected_resume.test');
const source = fs.readFileSync(fixtureFile, 'utf8');
const cutoff = source.indexOf("\ntest('selectable suffix");
assert(cutoff > 0, 'Synthetic fixture boundary must remain explicit');
const marker = '      return context;\n    },\n    solutionsForCalendar:';
assert(source.includes(marker), 'Synthetic context hook boundary must remain explicit');
const fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, cutoff).replace(marker,
  '      if (state.adjustContext) state.adjustContext(context);\n      return context;\n    },\n    solutionsForCalendar:')
  + '\nmodule.exports = { fixture };', { module: fixtureModule, exports: fixtureModule.exports,
  require: createRequire(fixtureFile), console, Date, Map, Set, Promise, structuredClone }, { filename: fixtureFile });
const { fixture } = fixtureModule.exports;
const { bookingRequest } = require('../../lib/program-booking');
const { programScheduleReceiptMatches } = require('../../lib/program-schedule-confirmation');
const { createSeriesContext, assertSeriesContext } = require('../../lib/program-replan');
const clone = value => JSON.parse(JSON.stringify(value));
const chosen = (key, date = '2030-02-04') => ({ key, start_at: `${date}T09:00:00.000Z`,
  selections: { t1_p1: { doctor_id: 5, installation_id: 9 }, t1_p2: { doctor_id: 6, installation_id: 10 } } });
function closedFixture(options) {
  const f = fixture(options);
  f.state.adjustContext = context => { context.doctors.get(5).windows = []; };
  return f;
}
async function receipt(f, sessions = [chosen('s0')], extra = {}) {
  let error;
  try { await f.book(sessions, extra); } catch (caught) { error = caught; }
  assert.equal(error?.code, 'program_schedule_confirmation_required');
  assert.equal(error.details.can_confirm_schedule, true);
  assert.match(error.details.schedule_acknowledgement, /^[a-f0-9]{64}$/);
  return error.details;
}

test('explicit closed-staff preview warns; exact batch confirmation persists real occupancy/audit without messages or consumption', async () => {
  const f = closedFixture(), before = clone([f.state.voucher, f.state.budget]);
  const missingChoice = await f.propose({ from_date: '2030-02-04', days: 1, session_keys: ['s0'],
    manual_sessions: [{ key: 's0', start_local: '2030-02-04T10:00' }] });
  assert.equal(missingChoice.proposals[0].solution, null);
  const preview = await f.propose({ from_date: '2030-02-04', days: 1, session_keys: ['s0'],
    manual_sessions: [{ ...chosen('s0'), start_local: '2030-02-04T10:00' }] });
  assert(preview.proposals[0].solution); assert.equal(preview.proposals[0].requires_schedule_confirmation, true);
  assert(preview.proposals[0].schedule_restrictions.every(row => row.code === 'STAFF_OUT_OF_HOURS'));
  assert.match(preview.proposals[0].schedule_restrictions[0].message, /no tiene horario/);
  assert.equal(f.state.appointments.length, 0);
  const details = await receipt(f);
  assert.equal(f.state.records.length, 0); assert.equal(f.state.appointments.length, 0); assert.equal(f.state.requests.length, 0);
  const result = await f.book([chosen('s0')], { schedule_acknowledgement: details.schedule_acknowledgement });
  assert.equal(result.schedule_exception_confirmed, true); assert.equal(result.reminders_enabled, false);
  assert.equal(f.state.appointments.length, 1); assert(f.state.occupancies.some(row => row.resource_key === 'doctor:5'));
  const appointment = f.appointment('s0'); assert.equal(appointment.import_metadata.automation_policy, 'hold');
  assert.equal(appointment.import_metadata.program_schedule_confirmation.confirmed_by, 1);
  assert.equal(appointment.import_metadata.program_schedule_confirmation.acknowledgement, details.schedule_acknowledgement);
  assert.equal(appointment.import_metadata.booking.profile.phases.length, 2);
  assert.equal(appointment.import_metadata.booking.profile.phases[1].start_offset_minutes, 15);
  assert.deepEqual(clone([f.state.voucher, f.state.budget]), before);
});

test('all closed sessions are acknowledged together and replay never duplicates appointments', async () => {
  const f = closedFixture(), sessions = [chosen('s0'), chosen('s1', '2030-02-11')], extra = { request_key: 'closed-batch-stable' };
  const details = await receipt(f, sessions, extra);
  assert.deepEqual(clone(details.batch_restrictions.map(row => row.key)), ['s0', 's1']);
  const accepted = { ...extra, schedule_acknowledgement: details.schedule_acknowledgement };
  const result = await f.book(sessions, accepted); assert.equal(result.sessions.length, 2);
  const replay = await f.book(sessions, accepted); assert.equal(replay.replayed, true); assert.equal(f.state.appointments.length, 2);
  await assert.rejects(f.book([chosen('s0', '2030-02-05'), sessions[1]], accepted), { code: 'program_booking_request_conflict' });
});

test('changed actor, time, selection, balance, patient, or schedule facts invalidate the uncommitted batch receipt', async () => {
  for (const change of [
    (f, input) => { f.options.actorId = 2; },
    (f, input) => { input[0].start_at = '2030-02-04T09:15:00.000Z'; },
    (f, input) => { f.state.voucher.available_units = 3; },
    (f, input) => { f.state.voucher.patient_id = 2; f.state.budget.patient_id = 2; },
    (f, input) => { f.state.adjustContext = context => { context.doctors.get(5).windows = [{ start: '2030-02-04T07:00:00Z', end: '2030-02-04T08:00:00Z' }]; }; },
  ]) {
    const f = closedFixture(), input = [chosen('s0')], details = await receipt(f, input);
    change(f, input);
    const next = await receipt(f, input, { schedule_acknowledgement: details.schedule_acknowledgement });
    assert.notEqual(next.schedule_acknowledgement, details.schedule_acknowledgement);
    assert.equal(f.state.records.length, 0); assert.equal(f.state.appointments.length, 0);
  }
  const f = closedFixture({ alternatives: true }), input = [chosen('s0')], details = await receipt(f, input);
  input[0].selections.t1_p1.installation_id = 11;
  assert.notEqual((await receipt(f, input, { schedule_acknowledgement: details.schedule_acknowledgement })).schedule_acknowledgement,
    details.schedule_acknowledgement);
});

test('occupancy, vacations, closed clinic/room, room permissions and inaccessible staff stay hard even with a prior receipt', async () => {
  const changes = [
    context => context.doctors.get(5).busy.push({ start: '2030-02-04T09:00:00Z', end: '2030-02-04T10:00:00Z', appointment_id: 44 }),
    context => context.doctors.get(5).absence_windows.push({ start: '2030-02-04T09:00:00Z', end: '2030-02-04T10:00:00Z' }),
    context => { context.clinicWindows = []; },
    context => { context.installations.get(9).windows = []; },
    context => context.installations.get(9).busy.push({ start: '2030-02-04T09:00:00Z', end: '2030-02-04T10:00:00Z' }),
    context => { context.installations.get(9).profesionales_permitidos = [6]; },
    context => { context.doctors.delete(5); },
    context => context.patientBusy.push({ start: '2030-02-04T09:00:00Z', end: '2030-02-04T10:00:00Z', clinic_id: 73 }),
  ];
  for (const change of changes) {
    const f = closedFixture(), details = await receipt(f);
    f.state.adjustContext = context => { context.doctors.get(5).windows = []; change(context); };
    await assert.rejects(f.book([chosen('s0')], { schedule_acknowledgement: details.schedule_acknowledgement }), { code: 'program_booking_unavailable' });
    assert.equal(f.state.records.length, 0); assert.equal(f.state.appointments.length, 0);
  }
});

test('real machine occupation or maintenance cannot be relaxed with a closed-staff acknowledgement', async () => {
  for (const change of [
    unit => unit.busy.push({ start: '2030-02-04T09:00:00Z', end: '2030-02-04T10:00:00Z' }),
    unit => { unit.status = 'maintenance'; },
    unit => unit.installation_ids.clear(),
  ]) {
    const f = closedFixture({ machine: true }), details = await receipt(f);
    f.state.adjustContext = context => { context.doctors.get(5).windows = []; change(context.equipment.get(11)); };
    await assert.rejects(f.book([chosen('s0')], { schedule_acknowledgement: details.schedule_acknowledgement }), { code: 'program_booking_unavailable' });
    assert.equal(f.state.appointments.length, 0); assert.equal(f.state.occupancies.length, 0);
  }
});

test('later hard conflict aborts the entire batch before any earlier unrestricted or closed session is written', async () => {
  const f = closedFixture();
  f.state.busy.push({ kind: 'doctor', id: 6, start: '2030-02-11T09:00:00Z', end: '2030-02-11T10:00:00Z' });
  await assert.rejects(f.book([chosen('s0'), chosen('s1', '2030-02-11')], { schedule_acknowledgement: 'a'.repeat(64) }), { code: 'program_booking_unavailable' });
  assert.equal(f.state.records.length, 0); assert.equal(f.state.appointments.length, 0); assert.equal(f.state.occupancies.length, 0);
});

test('fixed explicitly selected closed proposals remain preview-only and constrain subsequent manual choices', async () => {
  const f = closedFixture();
  const result = await f.propose({ from_date: '2030-02-04', days: 1, session_keys: ['s1'],
    fixed_sessions: [chosen('s0')], manual_sessions: [{ ...chosen('s1'), start_local: '2030-02-04T11:00' }] });
  assert(result.proposals[0].solution); assert.equal(result.proposals[0].requires_schedule_confirmation, true);
  assert.equal(f.state.records.length, 0); assert.equal(f.state.appointments.length, 0);
});

test('automatic date searches never invent availability outside working hours', async () => {
  const f = closedFixture({ manual: false });
  const result = await f.propose({ from_date: '2030-02-04', days: 1, session_keys: ['s0'] });
  assert.equal(result.proposals[0].solution, null); assert.equal(result.proposals[0].requires_schedule_confirmation, undefined);
});

test('an automatic program permits an explicitly chosen closed date without dropping its documented cadence', async () => {
  const f = closedFixture({ manual: false });
  const preview = await f.propose({ from_date: '2030-02-04', days: 1, session_keys: ['s0'],
    manual_sessions: [{ ...chosen('s0'), start_local: '2030-02-04T10:00' }] });
  assert(preview.proposals[0].solution); assert.equal(preview.proposals[0].requires_schedule_confirmation, true);
  const details = await receipt(f);
  await f.book([chosen('s0')], { schedule_acknowledgement: details.schedule_acknowledgement });
  const next = await f.propose({ from_date: '2030-02-05', days: 1, session_keys: ['s1'],
    manual_sessions: [{ ...chosen('s1', '2030-02-05'), start_local: '2030-02-05T10:00' }] });
  assert.equal(next.proposals[0].solution, null); assert.equal(next.proposals[0].reason_code, 'program_cadence_conflict');
});

test('mandatory ALL staff remain implicit and all are physically reserved; the dialog cannot narrow the team', async () => {
  const f = closedFixture({ mandatoryTeam: true }), input = chosen('s0');
  input.selections.t1_p2 = { installation_id: 10 };
  const details = await receipt(f, [input]);
  await f.book([input], { schedule_acknowledgement: details.schedule_acknowledgement });
  const occupancy = f.state.occupancies.filter(row => row.resource_kind === 'doctor');
  assert(occupancy.some(row => row.doctor_id === 5)); assert(occupancy.some(row => row.doctor_id === 6)); assert(occupancy.some(row => row.doctor_id === 7));
  const bad = closedFixture({ mandatoryTeam: true });
  await assert.rejects(bad.book([chosen('s0')]), { code: 'program_booking_unavailable' });
  assert.equal(bad.state.appointments.length, 0);
});

test('acknowledgement is separate from idempotent intent, validated strictly and not replaceable by force', async () => {
  const payload = { request_key: 'parser-stable', snapshot_sha256: 'a'.repeat(64), sessions: [chosen('s0')] };
  assert.equal(bookingRequest(payload).request_sha256, bookingRequest({ ...payload, schedule_acknowledgement: 'b'.repeat(64) }).request_sha256);
  for (const invalid of [true, 1, {}, ['b'.repeat(64)], 'b'.repeat(63)]) assert.throws(() => bookingRequest({ ...payload, schedule_acknowledgement: invalid }), { code: 'program_schedule_acknowledgement_invalid' });
  const f = closedFixture(); await receipt(f, [chosen('s0')], { force: true }); assert.equal(f.state.appointments.length, 0);
  assert.equal(programScheduleReceiptMatches('a'.repeat(64), 'b'.repeat(64)), false);
});

test('transaction-owned exception receipt cannot be forged, moved to another patient/transaction or mutated after registration', () => {
  const transaction = {}, plan = { voucher: { id: 1, public_id: 'purchase', clinic_id: 72, patient_id: 1 }, timeZone: 'Europe/Madrid' };
  const selected = [{ key: 's0', record: { id: 1 }, start_at: '2030-02-04T09:00:00Z', end_at: '2030-02-04T09:45:00Z' }];
  const receipt = { doctorIds: [5], actorId: 1, acknowledgement: 'a'.repeat(64), restrictions: [{ code: 'STAFF_OUT_OF_HOURS' }] };
  const token = createSeriesContext({ transaction, plan, selected, series: selected, scheduleExceptions: new Map([['s0', receipt]]) });
  const input = { transaction, session: { id: 1, voucher_id: 1, session_key: 's0' }, existing: null,
    values: { voucher_id: 1, clinica_id: 72, paciente_id: 1, inicio: selected[0].start_at, fin: selected[0].end_at } };
  receipt.doctorIds.push(999);
  assert.deepEqual(assertSeriesContext(token, input).scheduleException.doctorIds, [5]);
  for (const invalid of [{ ...input, transaction: {} }, { ...input, values: { ...input.values, paciente_id: 2 } }]) assert.throws(() => assertSeriesContext(token, invalid), /program_series_context_invalid/);
  assert.throws(() => assertSeriesContext({ scheduleException: receipt }, input), /program_series_context_invalid/);
});

test('malformed resource selection cannot widen the purchased treatment or room authorizations', async () => {
  const f = closedFixture();
  for (const selections of [{ forged: { doctor_id: 5, installation_id: 9 } },
    { t1_p1: { doctor_id: 999, installation_id: 9 }, t1_p2: { doctor_id: 6, installation_id: 10 } },
    { t1_p1: { doctor_id: 5, installation_id: 999 }, t1_p2: { doctor_id: 6, installation_id: 10 } }]) {
    await assert.rejects(f.book([{ ...chosen('s0'), selections }]), error => ['program_selection_invalid', 'program_booking_unavailable'].includes(error.code));
    assert.equal(f.state.appointments.length, 0);
  }
});
