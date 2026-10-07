'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { bookingError, bookingErrorMiddleware } = require('../../services/treatmentBookingProfile.service');
test('same-day choice and linking errors retain actionable HTTP409 code and details', () => {
 for (const code of ['appointment_same_day_choice_required', 'appointment_link_changed', 'appointment_link_care_started']) {
  let status, payload, next = false;
  bookingErrorMiddleware(bookingError(code, 'Revisa la unión.', { appointments: [{ id: 1 }] }), {},
   { status(value) { status = value; return this; }, json(value) { payload = value; } }, () => { next = true; });
  assert.equal(status, 409); assert.equal(payload.code, code); assert.equal(payload.details.appointments[0].id, 1); assert.equal(next, false);
 }
 const source = fs.readFileSync(require.resolve('../../controllers/citas.controller'), 'utf8');
 assert.match(source, /booking_\|appointment_visit_\|appointment_consent_\|appointment_link_\|appointment_same_day_/);
});
