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

test('only explicit booking instructions allow two first visits for leads', () => {
  const { allowsLeadPair } = require('../../services/leadAssistantOverlap.service');
  for (const text of [
    'Se pueden citar dos leads a la misma hora',
    'Se permite montar dos leads si no hay cita de paciente',
    'Si ambos son leads, se puede montar. No montar nunca sobre pacientes.',
    'Se permite doblar leads. Nunca doblar a pacientes.',
    'Pueden montar dos leads. Si ya hay una cita agendada que no es lead, no montar.',
    'Se permite doblar leads, pero no montar si hay una cita de paciente.',
  ]) assert.equal(allowsLeadPair(text), true, text);
  for (const text of [
    'Solo si hay permiso se pueden doblar los leads',
    'Se permite montar dos leads los viernes',
    'Se pueden montar dos leads. Doblar leads está prohibido.',
    '¿Se pueden montar dos leads a la vez?',
    'No está permitido citar dos leads a la misma hora',
  ]) assert.equal(allowsLeadPair(text), false, text);
});

test('offers agenda times in spoken order and collects email and phone together', () => {
  const { displayOptions } = require('../../services/leadAssistantCalendar.service');
  const slots = ['2030-01-07T09:00', '2030-01-07T09:15', '2030-01-08T10:00'].map(local => ({ local, start: local + ':00+01:00' }));
  assert.equal(displayOptions(slots.slice(0, 2), 'Europe/Madrid'), 'el lunes 7 de enero a las 09:00 o a las 09:15');
  assert.equal(displayOptions([slots[0], slots[2]], 'Europe/Madrid'), 'el lunes 7 de enero a las 09:00 o el martes 8 de enero a las 10:00');
  assert.deepEqual(readContact('Mi móvil es 600123453 y mi correo es prueba@example.org'),
    { name: null, phone: '+34600123453', email: 'prueba@example.org' });
});

test('appointment requests in ordinary Spanish, scoped status and informational questions stay distinct',()=>{
 const {bookingRequest,asksSessionAppointment}=require('../../services/leadAssistantCalendar.service');
 for(const text of ['jo qué pesada, sí dame cita','me ibas a dar cita','hola quería cita para algo para el cuello',
   '¿Podéis darme hora para una primera valoración?']) assert(bookingRequest(text),text);
 for(const text of ['¿Qué tal es la valoración?','No quiero reservar','¿Qué hace la radiofrecuencia?'])
   assert(!bookingRequest(text),text);
 assert(asksSessionAppointment('cuando has idcho que era mi cita?'));
 assert(!asksSessionAppointment('Quiero cancelar mi cita'));
});

test('commercial results, ambiguous acceptances and opening hours are distinct from appointment consent',()=>{
  const calendar=require('../../services/leadAssistantCalendar.service');
  assert(!calendar.bookingRequest('Tengo un hueco oscuro. ¿Me garantizas que desaparecerá en una sesión si pago hoy?'));
  assert(calendar.bookingRequest('Quiero ver qué huecos quedan para una valoración de ojeras.'));
  assert(calendar.bookingRequest('¿Y si mejor me dices las primeras horas de verdad?'));
  for(const q of ['No quiero cita hasta saberlo','No confirmo. Me lo pienso.','La segunda, no, espera: mejor no reserves todavía']) assert(calendar.defersBooking(q));
  for(const q of ['Si abrís a las nueve, ¿ya tengo cita a las nueve?','¿Entonces ya tengo una cita confirmada?','¿Llegaste a reservarla?']) assert(calendar.asksSessionAppointment(q));
});
