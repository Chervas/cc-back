'use strict';

// Deliberately narrow: reviewed facial individuals, or the two separately
// reviewed single-equipment body modalities. Never infer a combined protocol.
// This is operational catalogue activation, never clinical/legal approval.
const { hash } = require('./adapter');
const { verifyPlan, BATCH } = require('./catalog-drafts');
const { normalizeBookingProfile } = require('../booking-profile');
const { normalizeProfile } = require('../economicPriceProfile');
const { equipmentFitsRoom } = require('../booking-equipment');
const VERSION = 'cliniccloud-catalog-simple-activation/1';
const EQUIPMENT_SCOPE = 'reviewed_single_equipment_cosmetic_catalogue';
const fail = code => { throw Error(code); };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const initialNotice = 'Borrador importado: completar revisión de agenda, documentación y fiscalidad antes de activar.';

function prepare({ plan, review, before, createdAt = new Date().toISOString() }) {
  verifyPlan(plan);
  const usesEquipment = review?.scope === EQUIPMENT_SCOPE;
  if (review?.version !== 1 || !['reviewed_simple_facial_catalogue', EQUIPMENT_SCOPE].includes(review.scope)
    || review.plan_sha256 !== plan.plan_sha256 || !Array.isArray(review.bindings)
    || !review.bindings.length || review.bindings.length > 30
    || before.treatments.length !== review.bindings.length
    || new Set(review.bindings.map(b => b.id)).size !== review.bindings.length) fail('CATALOG_ACTIVATION_REVIEW_INVALID');
  if (before.clinics.length !== 1 || before.clinics[0].id_clinica !== 72
    || before.clinics[0].grupo_clinica_id !== 29) fail('CATALOG_ACTIVATION_CLINIC_CHANGED');
  if (before.appointments.length) fail('CATALOG_ACTIVATION_ALREADY_USED');
  const operations = review.bindings.map(binding => {
    const row = before.treatments.find(t => t.id_tratamiento === binding.id), config = row && decode(row.clinical_config);
    const source = plan.rows.find(s => s.proposed_code === row?.codigo);
    if (!row || hash(row) !== binding.before_sha256 || typeof binding.reason !== 'string' || binding.reason.length < 40
      || !source || source.kind !== 'treatment'
      || source.sheet !== (usesEquipment ? 'Tratamientos individuales' : 'Facial · tratamientos')
      || row.clinica_id !== 72 || row.origen !== 'clinica' || Number(row.activo) !== 0
      || config?.catalog_status !== 'draft' || config.import_batch !== BATCH
      || config.product_type !== 'treatment' || config.medical_area_code !== 'estetica'
      || config.source_catalog_key !== source.source_catalog_key || hash(config.source_catalog) !== hash(source.provenance)
      || row.nombre !== source.display_name || Number(row.sesiones_defecto) !== 1
      || config.import_issues?.some(issue => issue !== 'INSTALLATION_INACTIVE')) fail('CATALOG_ACTIVATION_DRAFT_CHANGED');
    const price = Number(row.precio_base), profile = normalizeProfile(config.price_profile);
    if (row.precio_base == null || !Number.isFinite(price) || price <= 0
      || source.source_price?.mode !== 'fixed' || source.source_price.includes_tax !== true
      || source.source_price.gross_amount !== price || config.fiscal_mapping_pending !== false
      || !config.imported_price_review || !profile
      || config.imported_price_review.gross_amount !== price
      || hash(normalizeProfile(config.imported_price_review.price_profile)) !== hash(profile)) fail('CATALOG_ACTIVATION_PRICE_PENDING');
    const booking = normalizeBookingProfile(config.booking_profile);
    const phase = booking?.phases[0];
    if (!booking || booking.version !== (usesEquipment ? 2 : 1) || booking.phases.length !== 1
      || (usesEquipment ? phase.equipment_requirements?.length !== 1 || phase.equipment_requirements[0].equipment_ids.length !== 1 : phase.equipment_requirements?.length)
      || phase.installation_ids.length !== 1 || phase.professionals.ids.length !== 1
      || phase.professionals.mode !== 'any' || phase.professionals.preferred_id !== phase.professionals.ids[0]
      || source.duration_info.mode !== 'fixed' || source.duration_info.minutes !== row.duracion_min
      || phase.duration_minutes !== row.duracion_min) fail('CATALOG_ACTIVATION_SIMPLE_PROFILE_REQUIRED');
    const room = before.rooms.find(r => r.id === phase.installation_ids[0]);
    const doctor = before.staff.find(d => d.doctor_id === phase.professionals.ids[0] && d.clinica_id === 72);
    const allowed = decode(room?.profesionales_permitidos);
    if (!room || room.clinica_id !== 72 || !room.activo || Number(room.capacidad) !== 1
      || room.tipo !== (usesEquipment ? 'box' : 'consulta') || room.tiempo_preparacion_minutos !== 0
      || !doctor?.activo || !doctor.recibe_citas
      || (usesEquipment ? doctor.doctor_id !== 221 || doctor.rol_en_clinica !== 'Auxiliares y enfermeros' : doctor.rol_en_clinica !== 'Doctores')
      || !Array.isArray(allowed) || !allowed.includes(doctor.doctor_id)
      || !before.staff_hours.some(h => h.doctor_clinica_id === doctor.id && h.activo && h.hora_inicio < h.hora_fin)
      || !before.room_hours.some(h => h.instalacion_id === room.id && h.activo && h.hora_inicio < h.hora_fin)) fail('CATALOG_ACTIVATION_RESOURCES_PENDING');
    if (usesEquipment) {
      // Exact reviewed source rows: INDIBA corporal and the standalone EXION
      // Body session, not their combination, pain or post-operative modalities.
      const family = { 18: 'indiba_rf', 21: 'exion' }[source.provenance.source_row];
      const equipment = before.equipment;
      const unit = equipment?.units?.find(u => u.id === phase.equipment_requirements[0].equipment_ids[0]);
      const policy = equipment?.policies?.find(p => p.installation_id === room.id);
      if (!family || price !== 90 || row.duracion_min !== 45 || profile.tax_percent !== 21
        || !unit || unit.family_key !== family || unit.owner_clinic_id !== 72 || unit.group_id !== 29
        || unit.turnaround_minutes !== 0
        || unit.mobility !== (family === 'exion' ? 'mobile' : 'fixed')
        || equipment.units.filter(u => u.family_key === family).length !== 1
        || equipment.aliases.some(a => a.installation_id === room.id || a.installation_id === unit.home_installation_id)
        || !equipment.clinics.some(c => c.id_clinica === 72 && c.equipment_booking_enabled === 1)
        || !equipment.shares.some(s => s.equipment_id === unit.id && s.clinic_id === 72)
        || !equipmentFitsRoom({ ...unit, fixed_resource_key: `installation:${unit.home_installation_id}` },
          { resource_key: `installation:${room.id}`, equipment_policy: policy && { mode: policy.mode, equipment_ids: decode(policy.equipment_ids) } })) {
        fail('CATALOG_ACTIVATION_EQUIPMENT_PENDING');
      }
    }
    const requirements = before.requirements.filter(r => r.tratamiento_id === row.id_tratamiento);
    if (!requirements.length) fail('CATALOG_ACTIVATION_CONSENT_PENDING');
    for (const requirement of requirements) {
      const template = before.templates.find(t => t.id === requirement.clinic_template_id);
      const latest = before.versions.filter(v => v.clinic_template_id === template?.id).sort((a,b) => b.version-a.version || b.id-a.id)[0];
      if (requirement.clinica_id !== 72 || requirement.requirement_scope !== 'treatment' || requirement.condition_key
        || Number(requirement.required) !== 1 || requirement.blocking_policy !== 'hard'
        || template?.clinic_id !== 72 || template.purpose !== 'clinical' || template.status !== 'active'
        || template.blocking_policy !== 'hard' || /^DEMO\b/i.test(template.name)
        || latest?.status !== 'published' || latest.locale !== 'es' || !latest.body_html) fail('CATALOG_ACTIVATION_CONSENT_PENDING');
    }
    // Remove only our exact obsolete preparation notice, never a clinician's
    // narrative. The original stays in the package/journal and source metadata.
    const lines = String(row.descripcion || '').split('\n');
    if (lines.filter(line => line === initialNotice).length !== 1) fail('CATALOG_ACTIVATION_DESCRIPTION_CHANGED');
    return { id: row.id_tratamiento, before_sha256: hash(row), after: { ...row, activo: 1,
      descripcion: lines.filter(line => line !== initialNotice).join('\n'),
      clinical_config: { ...config, catalog_status: 'active', import_issues: [] } } };
  });
  const body = { version: VERSION, target: 'crm', created_at: createdAt, plan_sha256: plan.plan_sha256,
    review, before, before_sha256: hash(before), operations,
    policy: { prices_changed: false, profiles_changed: false, consents_changed: false, clinical_approval: false,
      appointments_changed: false, programs_changed: false, reminders_activated: false, legacy_catalog_unchanged: true } };
  return { ...body, package_sha256: hash(body) };
}

function verifyPackage(pkg, plan) {
  if (hash(prepare({ plan, review: pkg.review, before: pkg.before, createdAt: pkg.created_at })) !== hash(pkg)) fail('CATALOG_ACTIVATION_PACKAGE_CHANGED');
}
function verifyAfter(after, pkg) {
  if (after.treatments.length !== pkg.operations.length) fail('CATALOG_ACTIVATION_AFTER_COUNT');
  for (const row of after.treatments) {
    const op = pkg.operations.find(o => o.id === row.id_tratamiento);
    if (!op || hash({ ...row, updatedAt: op.after.updatedAt }) !== hash(op.after)) fail('CATALOG_ACTIVATION_AFTER_CHANGED');
  }
  if (hash({ ...after, treatments: pkg.before.treatments }) !== pkg.before_sha256) fail('CATALOG_ACTIVATION_DEPENDENCIES_CHANGED');
  return true;
}
module.exports = { VERSION, initialNotice, prepare, verifyPackage, verifyAfter };
