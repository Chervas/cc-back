'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bookingRequest,
  requestedCalendar,
  selection,
} = require('../../services/leadAssistantCalendar.service');
const { readContact } = require('../../services/leadAssistantBooking.service');
test('understands booking requests, a preferred local date and morning versus tomorrow', () => {
  for (const q of [
    '¿Me puedes dar una cita?',
    '¿Tenéis cita?',
    'Me gustaría una primera visita',
    'Quiero reservar',
    '¿Hay sitio?',
  ])
    assert(bookingRequest(q), q);
  for (const q of ['Ya tengo una cita', 'No quiero reservar', 'No me agendes una cita'])
    assert(!bookingRequest(q), q);
  const date = (q) => requestedCalendar(q, 'Europe/Madrid', new Date('2030-01-06T10:00:00Z'));
  assert.equal(date('¿Mañana por la tarde?').date, '2030-01-07');
  assert.equal(date('Por la mañana').days, 7);
  assert.equal(date('Por la mañana').period, 'manana');
  assert.equal(date('Lunes 7 de enero a las 9:15').hourMinute.value, 555);
  assert.equal(date('Martes 7 de enero'), null);
  assert.equal(date('El 30/02/2030'), null);
});
test('needs unambiguous consent to one offered option', () => {
  const slots = ['09:00', '09:15', '09:30'].map((t) => ({ local: '2030-01-07T' + t }));
  for (const q of ['La segunda', 'Sí, la segunda me viene bien', 'A las 9:15'])
    assert.deepEqual(selection(q, slots), { index: 1, confirmed: false });
  assert.deepEqual(selection('Sí, confirmo la segunda', slots), { index: 1, confirmed: true });
  assert.deepEqual(selection('Sí', slots, 1), { index: 1, confirmed: true });
  for (const q of ['Sí', 'No confirmo la segunda', 'La primera si hay', 'La primera o la tercera'])
    assert.equal(selection(q, slots), null);
  assert.equal(readContact('no me contactes'), null);
});
