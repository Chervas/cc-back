'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/program-reschedule');
const { bookingRequest } = require('../../lib/program-booking');
const now = new Date('2026-09-01Z');
function plan() {
  return { timeZone: 'Europe/Madrid', sessions: [
    ['s0', '2026-10-23T08:00:00.000Z'], ['s1', null], ['s2', '2026-10-30T09:00:00.000Z'], ['s3', '2026-11-09T10:30:00.000Z'],
  ].map(([key, start_at], position) => ({ key, position, scheduling_status: start_at ? 'reserved' : 'pending', start_at,
    record: { id: position + 1, voucher_id: 1 }, booking_profile: { version: 1, phases: [{ key: 'phase', duration_minutes: 30,
      installation_ids: [11, 12], professionals: { mode: 'any', ids: [3, 4], preferred_id: 3 } }] },
    ...(start_at ? { appointment: { id_cita: position + 100, estado: 'pendiente', inicio: start_at,
      import_metadata: { automation_policy: 'hold', booking: { phases: [{ key: 'phase', installation_id: 11, doctor_ids: [3] }] } } } } : {}) })) };
}
const input = (reschedule_scope = 'following') => ({ mode: 'reschedule', reschedule_scope, replan_from_key: 's0', expected_plan_revision: 'a'.repeat(64) });
test('reschedule selects exact future reserved source and never materializes unbooked, consumed or started units', () => {
  const p = plan(); assert.deepEqual(C.rescheduleSessions(p, input(), now).map(row => row.key), ['s0', 's2', 's3']);
  assert.deepEqual(C.rescheduleSessions(p, input('single'), now).map(row => row.key), ['s0']);
  p.sessions[2].appointment.care_started_at = now; assert.deepEqual(C.rescheduleSessions(p, input(), now).map(row => row.key), ['s0', 's3']);
  p.sessions[3].record.consumption_movement_id = 9; assert.deepEqual(C.rescheduleSessions(p, input(), now).map(row => row.key), ['s0']);
  for (const change of [q => { q.sessions[0].scheduling_status = 'completed'; }, q => { q.sessions[0].appointment.care_started_at = now; },
    q => { q.sessions[0].appointment.import_metadata.automation_policy = 'allowed'; }, q => { q.sessions[0].start_at = '2026-08-01Z'; }]) {
    const q = plan(); change(q); assert.throws(() => C.rescheduleSessions(q, input(), now));
  }
});
test('following preserves real civil separations and existing resources across DST, not an elapsed UTC delta', () => {
  const p = plan(), selected = C.rescheduleSessions(p, input(), now);
  const choices = C.shiftedChoices(p, selected, input(), '2026-10-26T12:00', [{ key: 's0', selections: { phase: { installation_id: 12, doctor_id: 4 } } }]);
  assert.deepEqual(choices.map(row => row.start_local), ['2026-10-26T12:00', '2026-11-02T12:00', '2026-11-12T13:30']);
  assert.equal(choices[0].start_at, '2026-10-26T11:00:00.000Z'); assert.equal(choices[1].start_at, '2026-11-02T11:00:00.000Z');
  assert.deepEqual(choices[0].selections.phase, { installation_id: 12, doctor_id: 4 });
  assert.deepEqual(choices[1].selections.phase, { installation_id: 11, doctor_id: 3 });
  const roomOnly = C.shiftedChoices(p, selected, input(), '2026-10-26T12:00', [{ key: 's0', selections: { phase: { installation_id: 12 } } }]);
  assert.deepEqual(roomOnly[0].selections.phase, { installation_id: 12, doctor_id: 3 }, 'A room-only override preserves the actual clinician');
  C.assertCivilShift(p, selected, { ...input(), sessions: choices });
  assert.notEqual(new Date(choices[0].start_at) - new Date(selected[0].start_at), new Date(choices[1].start_at) - new Date(selected[1].start_at));
  const changed = structuredClone(choices); changed[1].start_at = '2026-11-02T12:00:00.000Z';
  assert.throws(() => C.assertCivilShift(p, selected, { ...input(), sessions: changed }), { code: 'program_reschedule_intervals_changed' });
  assert.throws(() => C.assertCivilShift(p, selected, { ...input(), sessions: choices.slice(0, 1) }), { code: 'program_reschedule_incomplete' });
});
test('ambiguous/nonexistent DST target, forged source and foreign resource overrides reject', () => {
  const p = plan(), selected = C.rescheduleSessions(p, input(), now);
  for (const local of ['2026-10-25T02:30', '2027-03-28T02:30', 'wrong']) assert.throws(() => C.shiftedChoices(p, selected, input(), local));
  for (const overrides of [[{ key: 's1', selections: {} }], [{ key: 's0', start_local: '2026-10-26T12:00' }], [{ key: 's0' }, { key: 's0' }]]) {
    assert.throws(() => C.shiftedChoices(p, selected, input(), '2026-10-26T12:00', overrides));
  }
  p.sessions[0].appointment.import_metadata.booking.phases[0].doctor_ids = [999]; assert.throws(() => C.effectiveSelections(p.sessions[0]));
});
test('reschedule mode, exact scope, source and revision are strict and bound to receipt hash', () => {
  assert.equal(C.rescheduleInput({}), null);
  for (const change of [{ reschedule_scope: 'all' }, { replan_from_key: '' }, { expected_plan_revision: 'invalid' }]) assert.throws(() => C.rescheduleInput({ ...input(), ...change }));
  const base = { request_key: 'reschedule-test-key', snapshot_sha256: 'b'.repeat(64), sessions: [{ key: 's0', start_at: '2026-10-26T11:00:00.000Z' }] };
  const normal = bookingRequest(base), single = bookingRequest({ ...base, ...input('single') }), following = bookingRequest({ ...base, ...input() });
  assert.notEqual(normal.request_sha256, single.request_sha256); assert.notEqual(single.request_sha256, following.request_sha256);
  assert.equal(single.mode, 'reschedule'); assert.equal(single.reschedule_scope, 'single');
});
test('ordinary writer cannot move program dates; state/support-only and verified coordinator keep working', () => {
  const previous = { inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z', estado: 'pendiente' };
  for (const change of [{ inicio: '2030-01-08T09:00:00Z' }, { fin: '2030-01-07T09:45:00Z' }]) {
    assert.throws(() => C.assertCoordinatedScheduleChange(previous, { ...previous, ...change }, false), { code: 'program_reschedule_required' });
    C.assertCoordinatedScheduleChange(previous, { ...previous, ...change }, true);
  }
  C.assertCoordinatedScheduleChange(previous, { ...previous, estado: 'ha_acudido', additional_staff_ids: [5] }, false);
  C.assertCoordinatedScheduleChange(previous, { ...previous, inicio: new Date(previous.inicio), fin: new Date(previous.fin) }, false);
});
