'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { allowedMutation } = require('../qa/verify-program-agenda-widget-dev-ui');
const programId = '7ee16f23-a40e-4fe4-90d0-d02aac81dd69', voucherId = '11111111-2222-4333-8444-555555555555';
const request_key = '22222222-2222-4333-8444-555555555555';
const envelope = body => ({ method: 'POST', pathname: '/api/economics/patients/33021/program-enrollments',
  programId, voucherId, canEnroll: true, canBook: true, body });
test('native widget QA can enroll only its exact isolated patient/program, N=2 and explicit current operation', () => {
  const base = envelope({ clinic_id: 1, program_id: programId, program_version: 1, request_key, start_from_position: 2 });
  assert(allowedMutation(base));
  for (const changed of [{ canEnroll: false }, { method: 'DELETE' }, { pathname: '/api/economics/patients/33022/program-enrollments' },
    { body: { ...base.body, clinic_id: 82 } }, { body: { ...base.body, start_from_position: 1 } },
    { body: { ...base.body, program_id: voucherId } }, { body: { ...base.body, force: true } },
    { body: { ...base.body, unknown: true } }]) assert.equal(allowedMutation({ ...base, ...changed }), false);
});
test('provisional previews cannot escape the owned voucher, session prefix, reviewed horizon or coordinator', () => {
  const base = { ...envelope({ from_date: '2026-11-03', days: 90, draft_strategy: { action: 'initial' } }),
    pathname: `/api/economics/vouchers/${voucherId}/program-proposals` };
  assert(allowedMutation(base));
  for (const changed of [{ voucherId: null }, { pathname: '/api/citas' }, { method: 'PATCH' },
    { body: { ...base.body, days: 181 } }, { body: { ...base.body, from_date: '2026-11-02' } },
    { body: { ...base.body, draft_strategy: { action: 'cascade', pivot_key: 'qa_1' } } },
    { body: { ...base.body, draft_strategy: { action: 'reset', sessions: [{ key: 'another_program' }] } } }])
    assert.equal(allowedMutation({ ...base, ...changed }), false);
});
test('the sole allowed save is the two future isolated sessions; no extra sessions, overrides, costs or other data', () => {
  const sessions = ['qa_2', 'qa_3'].map((key, i) => ({ key, start_at: i ? '2026-11-18T15:00:00.000Z' : '2026-11-03T15:00:00.000Z',
    priority_acknowledged: false, selections: { first: { doctor_id: 220, installation_id: 73 }, second: { doctor_id: 221, installation_id: 74 } } }));
  const base = { ...envelope({ request_key, snapshot_sha256: 'a'.repeat(64), sessions,
    booking_preferences: { exclude_weekdays: [5], prefer_after_minutes: 960 } }), pathname: `/api/economics/vouchers/${voucherId}/program-appointments` };
  assert(allowedMutation(base));
  for (const changed of [{ canBook: false }, { pathname: '/api/messages' },
    { body: { ...base.body, sessions: [...sessions, { ...sessions[1], key: 'qa_4' }] } },
    { body: { ...base.body, sessions: [{ ...sessions[0], key: 'qa_1' }, sessions[1]] } },
    { body: { ...base.body, sessions: [{ ...sessions[0], start_at: '2026-11-06T15:00:00.000Z' }, sessions[1]] } },
    { body: { ...base.body, booking_preferences: {} } }, { body: { ...base.body, amount: 100 } },
    { body: { ...base.body, sessions: [{ ...sessions[0], selections: { first: { doctor_id: 2, installation_id: 73 }, second: sessions[0].selections.second } }, sessions[1]] } }])
    assert.equal(allowedMutation({ ...base, ...changed }), false);
});
