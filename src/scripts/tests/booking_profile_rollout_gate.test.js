'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingCapabilities, bookingErrorMiddleware, requireOperationalProfile, assertOperationalBookingProfile } = require('../../services/treatmentBookingProfile.service');
const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');

const profile = () => ({ version: 4, phases: [{ key: 'main', label: 'Prueba ficticia', start_offset_minutes: 0,
  duration_minutes: 30, installation_ids: [7], professionals: { mode: 'any', ids: [12], preferred_id: 12 } }] });
const environment = { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' };
const treatment = () => ({ origen: 'clinica', clinica_id: 72, activo: true, clinical_config: { booking_profile: profile() } });
const db = { Sequelize: { Op: { in: Symbol('in') } }, Instalacion: { findAll: async () => [{ id: 7 }] },
  DoctorClinica: { findAll: async () => [{ doctor_id: 12 }] } };

test('offset profiles require their own complete rollout, not just existing multi-resource flags', () => {
  for (const flags of [{}, { BOOKING_PHASE_OFFSETS_ENABLED: 'true' }, { BOOKING_PROFILES_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' },
    { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true' }, { ...environment, BOOKING_PHASE_OFFSETS_ENABLED: '1' }]) {
    const capabilities = bookingCapabilities(flags);
    assert.equal(capabilities.relativeSteps, false);
    assert.throws(() => requireOperationalProfile(treatment(), { capabilities }), { code: 'booking_profile_runtime_unavailable' });
  }
  assert.equal(requireOperationalProfile(treatment(), { capabilities: bookingCapabilities(environment) }).version, 4);
  assert.throws(() => assertOperationalBookingProfile(profile(), { capabilities: { simple: true, multi: true } }),
    { code: 'booking_profile_runtime_unavailable' }, 'contracted snapshots cannot bypass the version gate');
});

test('existing versions keep their rollout contract without a new environment flag', () => {
  for (const version of [1, 2, 3]) {
    const item = treatment(); item.clinical_config.booking_profile.version = version;
    delete item.clinical_config.booking_profile.phases[0].start_offset_minutes;
    assert.equal(requireOperationalProfile(item, { capabilities: { simple: true, multi: true } }).version, version);
  }
});

test('catalog save can prepare v4 but cannot publish it before compatible rollout', async () => {
  const item = treatment();
  await assert.rejects(validateCatalogResources(item, db, { environment: { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true' } }),
    { code: 'booking_profile_preparation_only' });
  item.activo = false; item.clinical_config.catalog_status = 'draft';
  await validateCatalogResources(item, db, { environment: {} });
  assert.equal(item.clinical_config.booking_profile.version, 4);
  assert.equal(item.activo, false);
  item.activo = true; delete item.clinical_config.catalog_status;
  await validateCatalogResources(item, db, { environment });
});

test('unquantified staff intervention remains visible and cannot be published or forced', async () => {
  const item = treatment(); item.clinical_config.booking_profile.phases[0].attention_requirements_pending =
    [{ key: 'midpoint', label: 'Control intermedio sin minutos confirmados' }];
  const capabilities = bookingCapabilities(environment);
  assert.throws(() => requireOperationalProfile(item, { capabilities }), { code: 'pending_attention_requirements', statusCode: 409 });
  await assert.rejects(validateCatalogResources(item, db, { environment }), { code: 'pending_attention_requirements' });
  item.activo = false; item.clinical_config.catalog_status = 'draft';
  await validateCatalogResources(item, db, { environment });
  assert.equal(item.clinical_config.booking_profile.phases[0].attention_requirements_pending.length, 1);
});

test('pending attention errors are actionable HTTP 409 responses, never forceable overlap errors', () => {
  let response, status, nextCalled = false;
  bookingErrorMiddleware({ code: 'pending_attention_requirements', statusCode: 409,
    message: 'Falta el tiempo de un control.', details: { can_force: true } }, {},
  { status: value => { status = value; return { json: value => { response = value; } }; } }, () => { nextCalled = true; });
  assert.equal(status, 409); assert.equal(nextCalled, false); assert.equal(response.can_force, false);
  assert.equal(response.message, 'Falta el tiempo de un control.');
});

test('multiple techniques may have separate steps, but an ambiguous all-machines attention override cannot become operational', () => {
  const item = profile(); item.phases[0].equipment_requirements = [{ equipment_ids: [4] }, { equipment_ids: [5] }];
  assert.throws(() => assertOperationalBookingProfile(item, { capabilities: bookingCapabilities(environment) }),
    { code: 'booking_profile_attention_ambiguous', statusCode: 409 });
});
