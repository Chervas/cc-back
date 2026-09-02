'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildWhatsappProfileAlignment,
  compareAddress,
  compareDisplayName,
} = require('../../lib/whatsapp-profile-alignment');

const clinic = {
  nombre_clinica: 'Clínica Dental Ejemplo Norte',
  direccion: 'Carrer Exemple, 275',
  codigo_postal: '08026',
  ciudad: 'Barcelona',
  provincia: 'Barcelona',
  pais: 'España',
};

test('marca la dirección de otro país como discrepancia objetiva', () => {
  const result = buildWhatsappProfileAlignment({
    clinic,
    verifiedName: 'Ejemplo Sur',
    additionalData: {
      profileAddress: 'Avenida Exemple 275, Santiago, Chile',
      profileCategory: 'HEALTH',
      profileWebsite: 'https://clinic-example.test',
      whatsappPhoneSync: { last_full_sync_at: '2026-09-01T12:00:00.000Z' },
    },
  });

  assert.equal(result.comparisons.address.status, 'mismatch');
  assert.deepEqual(result.comparisons.address.reason_codes, ['country_conflict']);
  assert.equal(result.comparisons.display_name.status, 'review');
  assert.equal(result.comparisons.display_name.reason_code, 'branch_qualifier_differs');
  assert.equal(result.risk_level, 'warning');
  assert.ok(result.risk_codes.includes('address:country_conflict'));
  assert.equal(result.clinic.address, 'Carrer Exemple, 275, 08026 Barcelona, España');
  assert.equal(result.meta.observed_at, '2026-09-01T12:00:00.000Z');
});

test('tolera abreviaturas, tildes y una dirección pública más corta', () => {
  const identity = buildWhatsappProfileAlignment({
    clinic,
    verifiedName: 'Clinica Dental Ejemplo Norte',
    additionalData: { profileAddress: 'C/ Exemple 275, Barcelona' },
  });

  assert.equal(identity.comparisons.display_name.status, 'aligned');
  assert.equal(identity.comparisons.address.status, 'aligned');
  assert.equal(identity.risk_level, 'none');
  assert.deepEqual(identity.risk_codes, []);
});

test('un nombre comercial abreviado compatible no genera riesgo', () => {
  assert.deepEqual(compareDisplayName('Marca Aurora CR', 'Marca Aurora'), {
    status: 'aligned',
    risk: false,
    reason_code: 'compatible_short_name',
  });
});

test('tolera una marca compuesta concatenada aunque cambie el orden de palabras', () => {
  assert.deepEqual(compareDisplayName('Fisioterapia Aurora', 'aurorafisioterapia'), {
    status: 'aligned',
    risk: false,
    reason_code: 'compatible_compound_name',
  });
});

test('no afirma discrepancia cuando falta uno de los datos', () => {
  assert.equal(compareDisplayName('Clínica Norte', null).status, 'missing');
  assert.equal(compareAddress({ address: null, address_parts: {} }, 'Calle Norte 1').risk, false);
});

test('detecta contradicciones de código postal y número de calle', () => {
  const result = buildWhatsappProfileAlignment({
    clinic,
    verifiedName: 'Clínica Dental Ejemplo Norte',
    additionalData: { profileAddress: 'Carrer Exemple 999, 28001 Madrid, España' },
  });

  assert.equal(result.comparisons.address.status, 'mismatch');
  assert.deepEqual(result.comparisons.address.reason_codes, [
    'postal_code_conflict',
    'street_number_conflict',
  ]);
});
