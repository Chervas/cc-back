'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingErrorMiddleware, bookingError } = require('../../services/treatmentBookingProfile.service');
const { assertCareStatusChange } = require('../../lib/appointment-care');

function response() {
  const calls = [];
  const res = {
    status(value) { calls.push(['status', value]); return this; },
    json(body) { calls.push(['json', body]); return this; },
  };
  return { res, calls };
}

test('real future no-show guard is serialized by the native booking router middleware', () => {
  let error;
  try {
    assertCareStatusChange({ estado: 'pendiente', inicio: '2030-01-07T10:00:00Z', paciente_id: 1 },
      { estado: 'no_asistio' }, new Date('2030-01-07T09:59:59Z'));
  } catch (caught) { error = caught; }
  assert.equal(error.code, 'care_no_show_too_early');
  const { res, calls } = response();
  bookingErrorMiddleware(error, { headers: { accept: 'application/json' } }, res,
    () => assert.fail('A known care domain error must not escape to HTML final handling'));
  assert.deepEqual(calls, [['status', 409], ['json', {
    code: 'care_no_show_too_early', message: error.message, details: null, can_force: false,
  }]]);
  assert.match(calls[1][1].message, /Todavía no ha llegado la hora/);
});

test('care lifecycle errors retain their actual status, code and safe details without force', () => {
  for (const [code, statusCode] of [
    ['care_action_invalid', 400], ['care_no_show_start_required', 409], ['care_already_arrived', 409],
    ['care_no_show_state_invalid', 409], ['care_start_required', 409], ['care_already_started', 409],
    ['care_already_completed', 409], ['care_legacy_attendance', 409], ['care_reservation_locked', 409],
  ]) {
    const error = Object.assign(new Error('Motivo de atención'), { code, statusCode, details: { action: 'review' } });
    const { res, calls } = response();
    bookingErrorMiddleware(error, {}, res, () => assert.fail('Known care error was delegated'));
    assert.equal(calls[0][1], statusCode);
    assert.deepEqual(calls[1][1], { code, message: error.message, details: error.details, can_force: false });
  }
});

test('unrelated or uncoded failures remain delegated rather than hidden as care conflicts', () => {
  for (const error of [new Error('Unexpected implementation error'),
    Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET', statusCode: 503 }),
    Object.assign(new Error('Unknown domain'), { code: 'unknown_domain', statusCode: 409 })]) {
    const { res, calls } = response();
    let delegated;
    bookingErrorMiddleware(error, {}, res, actual => { delegated = actual; });
    assert.equal(delegated, error);
    assert.deepEqual(calls, []);
  }
});

test('the existing booking confirmation payload remains unchanged', () => {
  const error = bookingError('booking_restriction_confirmation_required', 'Revisa los motivos', {
    can_confirm_restrictions: true, booking_restriction_acknowledgement: 'a'.repeat(64),
    booking_plan_sha256: 'b'.repeat(64), booking_restrictions: [{ code: 'STAFF_OUT_OF_HOURS', message: 'Fuera de horario' }],
  });
  const { res, calls } = response();
  bookingErrorMiddleware(error, {}, res, () => assert.fail('Existing booking error was delegated'));
  assert.equal(calls[0][1], 409);
  const body = calls[1][1];
  assert.equal(body.code, error.code);
  assert.equal(body.can_force, false);
  assert.equal(body.can_confirm_restrictions, true);
  assert.equal(body.booking_restriction_acknowledgement, error.details.booking_restriction_acknowledgement);
  assert.equal(body.booking_plan_sha256, error.details.booking_plan_sha256);
  assert.deepEqual(body.booking_restrictions, error.details.booking_restrictions);
});
