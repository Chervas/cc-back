'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  filterEffectiveWhatsappPhoneAssets,
} = require('../../lib/effective-whatsapp-phone');

const phones = [
  { id: 10, phoneNumberId: 'group-phone', assignmentScope: 'group' },
  { id: 11, phoneNumberId: 'clinic-phone', assignmentScope: 'clinic' },
];

test('una clínica con número propio no hereda la restricción del número de grupo', () => {
  assert.deepEqual(
    filterEffectiveWhatsappPhoneAssets(phones, { originId: 11, phoneNumberId: 'clinic-phone' }),
    [phones[1]],
  );
});

test('una clínica sin número propio conserva el emisor efectivo de grupo', () => {
  assert.deepEqual(
    filterEffectiveWhatsappPhoneAssets(phones, { originId: 10, phoneNumberId: 'group-phone' }),
    [phones[0]],
  );
});

test('sin configuración efectiva no se muestra una restricción ajena', () => {
  assert.deepEqual(filterEffectiveWhatsappPhoneAssets(phones, {}), []);
});
