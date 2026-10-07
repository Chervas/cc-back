'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeClinicalConfig, catalogDto, catalogState } = require('../../lib/treatment-catalog-contract');
const { validateCatalogResources } = require('../../lib/treatment-catalog-resources');
const { requireOperationalProfile, bookingCapabilities } = require('../../services/treatmentBookingProfile.service');
const { resolveBookingProfileDuration } = require('../../lib/booking-profile-duration');
const { individualBookingEligible } = require('../../lib/appointment-booking-catalog');

const environment = { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_PHASE_OFFSETS_ENABLED: 'true' };
const capabilities = bookingCapabilities(environment);
const phase = (patch = {}) => ({ key: 'care', label: 'Paso ficticio', duration_minutes: null,
  installation_ids: [7], professionals: { mode: 'any', ids: [12], preferred_id: 12 }, ...patch });
const profile = (version = 1, phases = [phase()]) => ({ version, phases: phases.map(value => ({ ...value,
  ...(version === 4 ? { start_offset_minutes: value.start_offset_minutes ?? 0 } : {}) })) });
const item = booking_profile => ({ id_tratamiento: 3, nombre: 'Individual ficticio', origen: 'clinica', clinica_id: 72,
  activo: true, precio_base: 100, clinical_config: { catalog_status: 'active', booking_profile } });
const db = () => {
  const calls = [];
  return { calls, Sequelize: { Op: { in: Symbol('in') } },
    Instalacion: { findAll: async input => { calls.push(['room', input]); return [{ id: 7 }]; } },
    DoctorClinica: { findAll: async input => { calls.push(['doctor', input]); return [{ doctor_id: 12 }, { doctor_id: 13 }]; } } };
};

test('operative catalogue authoring defers only duration and returns an actionable DTO for v1–4', async () => {
  for (const version of [1, 2, 3, 4]) {
    const source = profile(version), before = JSON.stringify(source);
    const config = mergeClinicalConfig(null, { catalog_status: 'active', booking_profile: source });
    const treatment = { ...item(source), clinical_config: config };
    const database = db();
    await validateCatalogResources(treatment, database, { environment });
    assert.equal(config.booking_profile.phases[0].duration_minutes, null);
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(catalogDto(treatment).duration_requirements,
      { required: true, input: 'duration_minutes', phases: [{ key: 'care', label: 'Paso ficticio' }] });
    assert.deepEqual(catalogState(treatment).booking_issues, ['booking_duration_required']);
    assert.equal(catalogState(treatment).booking_ready, false);
    assert.equal(individualBookingEligible(treatment, 72, { capabilities }), true);
    assert.throws(() => requireOperationalProfile(treatment, { capabilities }), { code: 'booking_duration_required', statusCode: 422 });
    assert.equal(requireOperationalProfile(treatment, { capabilities, durationSelection: { duration_minutes: 45 } }).phases[0].duration_minutes, 45);
    assert.equal(database.calls.find(([key]) => key === 'room')[1].where.activo, true);
    const doctorQuery = database.calls.find(([key]) => key === 'doctor')[1].where;
    assert.equal(doctorQuery.activo, true); assert.equal(doctorQuery.recibe_citas, true);
    assert.equal(treatment.clinical_config.booking_profile.phases[0].duration_minutes, null);
  }
});

test('fixed profiles and legacy sequential spans remain fixed while only null steps need input', () => {
  for (const version of [1, 2, 3]) {
    const fixed = profile(version, [phase({ duration_minutes: 30 })]);
    const config = mergeClinicalConfig({}, { catalog_status: 'active', booking_profile: fixed });
    assert.deepEqual(config.booking_profile, fixed);
    assert.deepEqual(catalogDto(item(fixed)).duration_requirements, { required: false, input: 'duration_minutes', phases: [] });
    assert.equal(catalogState(item(fixed)).booking_ready, true);
    assert.throws(() => resolveBookingProfileDuration(fixed, { durationSelection: { duration_minutes: 45 } }), { code: 'booking_duration_locked' });
    const mixed = profile(version, [phase({ key: 'fixed', duration_minutes: 30 }), phase({ key: 'chosen' })]);
    const template = mergeClinicalConfig({}, { catalog_status: 'active', booking_profile: mixed }).booking_profile;
    const effective = resolveBookingProfileDuration(template, { durationSelection: { phase_durations: { chosen: 20 } } });
    assert.deepEqual(effective.profile.phases.map(row => row.duration_minutes), [30, 20]);
    assert.deepEqual(template.phases.map(row => row.duration_minutes), [30, null]);
  }
});

test('incomplete resources remain draft-only; authoring and direct resource callers use the strict template contract', async () => {
  for (const missing of [phase({ installation_ids: [] }), phase({ professionals: { mode: 'any', ids: [], preferred_id: null } }),
    phase({ professionals: { mode: 'any', ids: [12, 13], preferred_id: null } })]) {
    const raw = profile(1, [missing]);
    assert.throws(() => mergeClinicalConfig(null, { catalog_status: 'active', booking_profile: raw }), { code: 'booking_profile_invalid' });
    await assert.rejects(validateCatalogResources(item(raw), db(), { environment }), { code: 'booking_profile_invalid' });
    const draft = mergeClinicalConfig(null, { catalog_status: 'draft', booking_profile: raw });
    assert.equal(draft.booking_profile.phases[0].duration_minutes, null);
    assert.equal(catalogDto({ ...item(raw), activo: false, clinical_config: draft }).duration_requirements, undefined);
    assert.equal(catalogState({ activo: false, clinical_config: draft }).booking_ready, false);
  }
  const database = db(); database.DoctorClinica.findAll = async () => [];
  await assert.rejects(validateCatalogResources(item(profile()), database, { environment }), { code: 'treatment_professional_scope', status: 403 });
  database.DoctorClinica.findAll = async () => [{ doctor_id: 12 }]; database.Instalacion.findAll = async () => [];
  await assert.rejects(validateCatalogResources(item(profile()), database, { environment }), { code: 'treatment_installation_scope', status: 403 });
});

test('duration templates retain fiscal, capability, team, machine and unquantified-attention gates', async () => {
  await assert.rejects(validateCatalogResources(item(profile()), db(), { environment: {} }), { code: 'booking_profile_preparation_only' });
  const fiscal = item(profile()); fiscal.clinical_config.fiscal_mapping_pending = true;
  await assert.rejects(validateCatalogResources(fiscal, db(), { environment }), { code: 'imported_treatment_fiscal_review_pending' });
  const team = item(profile(1, [phase({ professionals: { mode: 'all', ids: [12, 13], preferred_id: null } })]));
  await assert.rejects(validateCatalogResources(team, db(), { environment: { BOOKING_PROFILES_ENABLED: 'true' } }), { code: 'booking_profile_preparation_only' });
  const relative = item(profile(4));
  await assert.rejects(validateCatalogResources(relative, db(), { environment: { BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true' } }), { code: 'booking_profile_preparation_only' });
  const pending = item(profile(4, [phase({ attention_requirements_pending: [{ key: 'control', label: 'Minutos sin confirmar' }] })]));
  await assert.rejects(validateCatalogResources(pending, db(), { environment }), { code: 'pending_attention_requirements' });
  assert.throws(() => requireOperationalProfile(pending, { capabilities, durationSelection: { duration_minutes: 45 } }), { code: 'pending_attention_requirements' });
  const machine = item(profile(2, [phase({ equipment_requirements: [{ equipment_ids: [4] }] })]));
  await assert.rejects(validateCatalogResources(machine, db(), { environment }), { code: 'booking_equipment_preparation_only' });
  const ambiguous = item(profile(4, [phase({ equipment_requirements: [{ equipment_ids: [4] }, { equipment_ids: [5] }] })]));
  await assert.rejects(validateCatalogResources(ambiguous, db(), { environment }), { code: 'booking_profile_attention_ambiguous' });
});

test('deferred duration neither invents offset/end nor bypasses quantified attention when instantiated', () => {
  const source = profile(4, [phase({ staff_attention: [{ mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 }] })]);
  const template = mergeClinicalConfig({}, { catalog_status: 'active', booking_profile: source }).booking_profile;
  assert.equal(template.phases[0].duration_minutes, null);
  assert.equal(template.phases[0].start_offset_minutes, 0);
  assert.throws(() => resolveBookingProfileDuration(template, { durationSelection: { duration_minutes: 10 } }), { code: 'booking_duration_attention_invalid' });
  assert.equal(resolveBookingProfileDuration(template, { durationSelection: { duration_minutes: 30 } }).profile.phases[0].duration_minutes, 30);
  const ending = profile(4, [phase({ key: 'first', duration_minutes: 10 }), phase({ key: 'last', start_offset_minutes: 1439 })]);
  const endingTemplate = mergeClinicalConfig({}, { catalog_status: 'active', booking_profile: ending }).booking_profile;
  assert.equal(endingTemplate.phases[1].duration_minutes, null);
  assert.throws(() => resolveBookingProfileDuration(endingTemplate, { durationSelection: { phase_durations: { last: 2 } } }), { code: 'booking_profile_invalid' });
});
