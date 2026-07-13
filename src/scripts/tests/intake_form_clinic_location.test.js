'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveConfiguredFormClinicLocation,
} = require('../../lib/intakeFormClinicLocation');

const clinics = [
  { id_clinica: 19, grupoClinicaId: 5, nombre_clinica: 'Propdental Sants', estado_clinica: 1 },
  { id_clinica: 35, grupoClinicaId: 5, nombre_clinica: 'Propdental Nou Barris', estado_clinica: 1 },
  { id_clinica: 56, grupoClinicaId: 5, nombre_clinica: 'Propdental Sant Martí', estado_clinica: 1 },
  { id_clinica: 58, grupoClinicaId: 5, nombre_clinica: 'Propdental Badalona', estado_clinica: 1 },
  { id_clinica: 59, grupoClinicaId: 5, nombre_clinica: 'Propdental Hospitalet', estado_clinica: 1 },
];

const groupConfig = {
  assignment_scope: 'group',
  group_id: 5,
  config: {
    locations: [
      { id: '19', label: 'Barcelona - Sants', public_label: 'Barcelona - Sants' },
      { id: '35', label: 'Barcelona - Nou Barris', public_label: 'Barcelona - Nou Barris' },
      { id: '56', label: 'Barcelona - Sant Martí', public_label: 'Barcelona - Sant Martí' },
      { id: '58', label: 'Badalona', public_label: 'Badalona' },
      { id: '59', label: 'Hospitalet de Llobregat', public_label: 'Hospitalet de Llobregat' },
    ],
  },
};

function resolve(hint, overrides = {}) {
  return resolveConfiguredFormClinicLocation({
    hint,
    requestedGroupId: 5,
    configRecord: groupConfig,
    clinics,
    ...overrides,
  });
}

function testFivePropdentalLocations() {
  const expected = new Map([
    ['Propdental Sants', 19],
    ['Propdental Sant Martí', 56],
    ['Propdental Nou Barris', 35],
    ['Propdental Badalona', 58],
    ['Propdental Hospitalet de Llobregat', 59],
  ]);

  for (const [label, clinicId] of expected) {
    const result = resolve(label);
    assert.equal(result.matched, true, `${label} must resolve`);
    assert.equal(result.clinicId, clinicId, `${label} must stay in its configured clinic`);
    assert.equal(result.groupId, 5);
  }

  const publicAlias = resolve('BARCELONA - SANT MARTI');
  assert.equal(publicAlias.matched, true);
  assert.equal(publicAlias.clinicId, 56, 'The configured public alias must resolve accent-insensitively');
}

function testFailClosed() {
  const unknown = resolve('Propdental Clínica Inventada');
  assert.equal(unknown.matched, false);
  assert.equal(unknown.hasCandidate, true);
  assert.equal(unknown.reason, 'location_not_configured');

  const ambiguous = resolve('Centro compartido', {
    configRecord: {
      ...groupConfig,
      config: {
        locations: [
          { id: 19, label: 'Centro compartido' },
          { id: 56, label: 'Centro compartido' },
        ],
      },
    },
  });
  assert.equal(ambiguous.matched, false);
  assert.equal(ambiguous.reason, 'location_ambiguous');

  const outsideGroup = resolve('Propdental Fuera de scope', {
    configRecord: {
      ...groupConfig,
      config: { locations: [{ id: 74, label: 'Propdental Fuera de scope' }] },
    },
    clinics: [
      ...clinics,
      { id_clinica: 74, grupoClinicaId: 28, nombre_clinica: 'Propdental Fuera de scope', estado_clinica: 1 },
    ],
  });
  assert.equal(outsideGroup.matched, false);
  assert.equal(outsideGroup.reason, 'clinic_outside_group');

  const inactive = resolve('Propdental Sant Martí', {
    clinics: clinics.map((clinic) => (
      clinic.id_clinica === 56 ? { ...clinic, estado_clinica: 0 } : clinic
    )),
  });
  assert.equal(inactive.matched, false);
  assert.equal(inactive.reason, 'clinic_inactive');

  const mismatchedConfig = resolve('Propdental Sant Martí', {
    configRecord: { ...groupConfig, group_id: 28 },
  });
  assert.equal(mismatchedConfig.matched, false);
  assert.equal(mismatchedConfig.reason, 'group_scope_mismatch');
}

function testControllerOrder() {
  const controllerPath = path.resolve(__dirname, '../../controllers/intake.controller.js');
  const source = fs.readFileSync(controllerPath, 'utf8');
  const ingestStart = source.indexOf('exports.ingestLead =');
  const ingestEnd = source.indexOf('exports.previewLeadImport =', ingestStart);
  const ingest = source.slice(ingestStart, ingestEnd);
  const configuredResolution = ingest.indexOf('resolveConfiguredFormClinicLocation({');
  const invalidResponse = ingest.indexOf("error: 'invalid_form_location'");
  const groupFallback = ingest.indexOf('await resolveFallbackClinicForGroup(');
  const leadCreation = ingest.indexOf('await dedupeAndCreateLead(');

  assert.ok(configuredResolution >= 0, 'The configured label resolver must run during intake');
  assert.ok(
    configuredResolution < invalidResponse
      && invalidResponse < groupFallback
      && invalidResponse < leadCreation,
    'Invalid, ambiguous, or out-of-scope labels must return 422 before fallback or side effects',
  );
  assert.match(
    ingest.slice(configuredResolution, groupFallback),
    /configuredClinicMatch\.matched[\s\S]*clinicMatchSource = clinicMatchSource \|\| 'configured_location_label'/,
  );
}

testFivePropdentalLocations();
testFailClosed();
testControllerOrder();
console.log('intake_form_clinic_location.test.js OK');
