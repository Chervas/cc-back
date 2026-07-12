'use strict';

const assert = require('node:assert/strict');
const {
  configuredClinicIds,
  matchClinicByPageUrl,
  normalizeHttpUrl,
  pagePathMatchesClinic,
} = require('../../lib/intake-page-clinic');

const clinics = [
  { id_clinica: 19, estado_clinica: 1, url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-sants/' },
  { id_clinica: 55, estado_clinica: 0, url_web: null },
  { id_clinica: 56, estado_clinica: 1, url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-sant-marti/' },
  { id_clinica: 58, estado_clinica: 1, url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-badalona/' },
  { id_clinica: 77, estado_clinica: 1, url_web: 'https://www.propdental.es/' },
];

assert.deepEqual(
  configuredClinicIds({ config: { locations: [{ id: '19' }, { clinic_id: 56 }, { clinica_id: '56' }] } }),
  [19, 56],
);
assert.deepEqual(
  configuredClinicIds({ config: JSON.stringify({ locations: [{ value: '58' }] }) }),
  [58],
);
assert.deepEqual(normalizeHttpUrl('https://WWW.PropDental.es/a//b/?x=1'), {
  hostname: 'propdental.es',
  pathname: '/a/b',
});
assert.equal(pagePathMatchesClinic('/a/b', '/a'), true);
assert.equal(pagePathMatchesClinic('/ab', '/a'), false);

assert.equal(
  matchClinicByPageUrl(
    'https://propdental.es/clinicas-dentales/clinica-dental-sant-marti/?utm_source=test',
    clinics,
    [19, 56, 58],
  )?.id_clinica,
  56,
);
assert.equal(
  matchClinicByPageUrl(
    'https://www.propdental.es/clinicas-dentales/clinica-dental-sant-marti/equipo/',
    clinics,
    [19, 56, 58],
  )?.id_clinica,
  56,
);
assert.equal(
  matchClinicByPageUrl('https://www.propdental.es/', clinics, [19, 56, 58]),
  null,
  'A generic homepage must remain group-scoped when its clinic is not configured for that URL',
);
assert.equal(
  matchClinicByPageUrl('https://www.propdental.es/', clinics, [77])?.id_clinica,
  77,
);
assert.equal(
  matchClinicByPageUrl('https://evil.example/clinica-dental-sant-marti/', clinics, [56]),
  null,
);

console.log('intake_page_clinic.test.js OK');
