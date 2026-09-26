'use strict';

// Add explicit equipment requirements to reviewed, inactive imported drafts.
// No activation, room movement, fiscal decision or patient reservation.
const { hash } = require('./adapter');
const { normalizeBookingProfile } = require('../booking-profile');
const { equipmentFitsRoom } = require('../booking-equipment');
const VERSION = 'cliniccloud-catalog-equipment/1';
// Only families with reviewed documentary bindings, not every inventory entry.
const REVIEWED_MOBILITY = Object.freeze({ exion: 'mobile', emshape: 'mobile', cyclone: 'fixed', capillary_led: 'fixed' });
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const canonical = row => ({ ...row, clinical_config: json(row.clinical_config) });
const fail = () => { throw Error('CATALOG_EQUIPMENT_REVIEW_INVALID'); };

function prepareCatalogEquipment({ before, review, createdAt = new Date().toISOString() }) {
  if (!review || !String(review.confirmation_reference || '').trim() || !String(review.reviewed_by || '').trim()
    || !['2026-09-22', '2026-09-25'].includes(review.confirmed_on) || !Array.isArray(review.targets) || !review.targets.length
    || review.targets.length > 20 || new Set(review.targets.map(t => t.treatment_id)).size !== review.targets.length
    || !Number.isFinite(Date.parse(createdAt))) fail();
  const operations = review.targets.map(target => {
    const matches = before.treatments.filter(t => t.id_tratamiento === target.treatment_id);
    if (matches.length !== 1) fail();
    const row = canonical(matches[0]), config = row.clinical_config;
    const clinic = before.clinics.find(c => c.id_clinica === row.clinica_id);
    if (![66, 72].includes(row.clinica_id) || row.grupo_clinica_id !== null || row.activo !== 0
      || config?.catalog_status !== 'draft' || config.product_type !== 'treatment'
      || !['cliniccloud-bs-catalog-individuals-20260921', 'cliniccloud-program-examples-20260914'].includes(config.import_batch)
      || !config.source_catalog || hash(config.source_catalog) !== target.source_catalog_sha256
      || config.source_equipment_assignment || config.booking_profile?.version !== 1
      || clinic?.grupoClinicaId !== 29 || clinic.equipment_booking_enabled !== 1) fail();
    const profile = normalizeBookingProfile(config.booking_profile);
    if (profile.phases.length !== 1 || profile.phases[0].installation_ids.length !== 1
      || hash(profile) !== hash(config.booking_profile) || profile.phases[0].duration_minutes !== row.duracion_min) fail();
    const units = before.units.filter(u => u.id === target.equipment_id);
    if (units.length !== 1) fail();
    const unit = units[0];
    const capillaryLed = unit.family_key === 'capillary_led';
    if (review.confirmed_on !== (capillaryLed ? '2026-09-25' : '2026-09-22')) fail();
    // The LED confirmation concerns the separate ten-minute C2 session only.
    // It is not an authorization to add another visit to PRP/dutasteride or to
    // treat the integrated blue LED in ONA as this capillary physical unit.
    if (capillaryLed && (row.clinica_id !== 66 || row.duracion_min !== 10
      || config.source_cabin !== '2' || config.source_catalog.sheet !== 'Capilar · sesiones y bonos'
      || config.source_catalog.source_row !== 43 || unit.home_installation_id !== 75)) fail();
    if (unit.group_id !== 29 || unit.owner_clinic_id !== (capillaryLed ? 66 : 72) || unit.mobility !== REVIEWED_MOBILITY[unit.family_key]
      || unit.family_key !== target.family_key || !Object.hasOwn(REVIEWED_MOBILITY, unit.family_key)
      || unit.status !== 'available' || !before.shares.some(s => s.equipment_id === unit.id && s.clinic_id === row.clinica_id)) fail();
    let resourceUnit = unit;
    if (unit.mobility === 'fixed') {
      const home = before.rooms.find(r => r.id === unit.home_installation_id);
      // This operator accepts a canonical, confirmed physical home only.
      // It does not move machines or infer a home from the treatment's name.
      if (!home || home.clinica_id !== unit.owner_clinic_id || home.activo !== 1 || home.capacidad !== 1
        || before.aliases.some(a => a.installation_id === home.id)) fail();
      resourceUnit = { ...unit, fixed_resource_key: `installation:${home.id}` };
    }
    for (const id of profile.phases[0].installation_ids) {
      const room = before.rooms.find(r => r.id === id);
      const physical = before.aliases.find(a => a.installation_id === id)?.canonical_installation_id || id;
      const policy = before.policies.find(p => p.installation_id === physical);
      if (room?.clinica_id !== row.clinica_id || room.activo !== 1 || room.capacidad !== 1
        || !policy || !equipmentFitsRoom(resourceUnit, { resource_key: `installation:${physical}`,
          equipment_policy: { mode: policy.mode, equipment_ids: json(policy.equipment_ids) } })) fail();
    }
    const nextProfile = normalizeBookingProfile({ version: 2, phases: profile.phases.map(phase => ({ ...phase,
      equipment_requirements: [{ equipment_ids: [unit.id] }] })) });
    const afterConfig = { ...config, booking_profile: nextProfile,
      import_issues: (config.import_issues || []).filter(issue => issue !== 'INSTALLATION_INACTIVE'),
      source_equipment_assignment: { version: 1, confirmation_reference: review.confirmation_reference,
        reviewed_by: review.reviewed_by, reviewed_at: createdAt, review_sha256: hash(review),
        equipment_id: unit.id, family_key: unit.family_key, previous_profile: config.booking_profile,
        equipment_revision: unit.revision, activation: false, existing_reservations_reconciled: false } };
    return { id: row.id_tratamiento, before: row, before_sha256: hash(row), after_config: afterConfig };
  });
  const body = { version: VERSION, target: 'crm', group_id: 29, created_at: createdAt,
    review_sha256: hash(review), before_sha256: hash(before), before, operations,
    policy: { inactive_drafts_only: true, prices_changed: false, appointments_changed: false,
      rooms_changed: false, reminders_activated: false, columns: ['clinical_config', 'updatedAt'] } };
  return { ...body, package_sha256: hash(body) };
}
function verifyCatalogEquipment(pkg, review) {
  if (hash(prepareCatalogEquipment({ before: pkg.before, review, createdAt: pkg.created_at })) !== hash(pkg)) fail();
}
function equipmentConfig(op, pkg) {
  return { ...op.after_config, source_equipment_assignment: { ...op.after_config.source_equipment_assignment,
    package_sha256: pkg.package_sha256 } };
}
function equipmentReplay(raw, op, pkg) {
  if (!raw) return false;
  const row = canonical(raw);
  return hash(row.clinical_config) === hash(equipmentConfig(op, pkg))
    && hash({ ...row, clinical_config: op.before.clinical_config, updatedAt: op.before.updatedAt }) === op.before_sha256;
}
module.exports = { prepareCatalogEquipment, verifyCatalogEquipment, equipmentConfig, equipmentReplay, canonical };
