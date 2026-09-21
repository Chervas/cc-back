'use strict';

const { hash, norm } = require('./adapter');
const { normalizeBookingProfile } = require('../booking-profile');
const VERSION = 'cliniccloud-catalog-drafts/1';
const BATCH = 'cliniccloud-bs-catalog-individuals-20260921';
const fail = code => { throw Error(code); };
function areaFor(row) {
  if (row.sheet.startsWith('Capilar')) return 'capilar';
  if (row.sheet === 'Obesidad · tarifa') {
    if (norm(row.category) === 'NUTRICION') return 'nutricion';
    if (['PSICOLOGIA', 'PSICONUTRICION'].includes(norm(row.category))) return 'psicologia';
    if (norm(row.category) === 'CIRUGIA BARIATRICA') return 'cirugia_digestiva';
    return 'general';
  }
  if (['Tratamientos individuales', 'Programas y mantenimientos', 'Facial · tratamientos',
    'Facial · programas', 'Cirugía plástica · tarifa'].includes(row.sheet)) return 'estetica';
  fail('CATALOG_AREA_NOT_REVIEWED');
}
function treatmentDraft(row) {
  if (row.kind !== 'treatment' || !row.safe_for_draft_import || ![66,72].includes(row.clinic_id)
    || !row.display_name || row.display_name.length > 255 || !/^[a-f0-9]{64}$/.test(row.source_catalog_key)
    || row.proposed_code !== `BS26-${row.source_catalog_key.slice(0,20)}`
    || (row.sheet.startsWith('Capilar') ? row.clinic_id !== 66 : row.clinic_id !== 72)) fail('CATALOG_ROW_NOT_AN_INDIVIDUAL');
  const area = areaFor(row);
  const config = { ...row.proposed_clinical_config, catalog_status: 'draft', medical_area_code: area,
    product_type: 'treatment', source_catalog_key: row.source_catalog_key, source_cabin: row.cabin,
    source_professional: row.professional, source_detail: row.detail, source_category: row.category,
    source_duration: row.duration, fiscal_mapping_pending: true, import_batch: BATCH };
  // A draft can reference an inactive but clinic-owned physical room. Never
  // turn two written rooms into alternatives or invent a clinical phase split.
  delete config.booking_profile;
  const rooms = row.installation_resolution || [], staff = row.professional_resolution || [];
  if (rooms.length === 1 && rooms[0].confirmed_id && rooms[0].confirmed_clinic_id === row.clinic_id
    && row.duration_info.mode === 'fixed' && staff.length && staff.every(p => p.confirmed_id)
    && !row.issues.includes('INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION')
    && !row.issues.includes('ADMINISTRATIVE_ACT_NOT_AUTOMATIC_BOOKING')) {
    config.booking_profile = normalizeBookingProfile({ version: 1, phases: [{ key: 'phase_1', label: row.name.slice(0,120),
      duration_minutes: row.duration_info.minutes, installation_ids: [rooms[0].confirmed_id],
      professionals: { mode: row.professional_mode, ids: staff.map(p => p.confirmed_id),
        preferred_id: row.professional_mode === 'any' && staff.length === 1 ? staff[0].confirmed_id : null },
    }] }, { allowIncomplete: true });
  }
  const description = [row.detail, `Cabina indicada: ${row.cabin || 'pendiente'}. Profesional indicado: ${row.professional || 'pendiente'}.`,
    `Precio final de origen: ${row.price}. Duración de origen: ${row.duration || 'pendiente'}.`,
    'Borrador importado: completar revisión de agenda, documentación y fiscalidad antes de activar.'].filter(Boolean).join('\n');
  return { nombre: row.display_name, codigo: row.proposed_code, disciplina: area, especialidad: null,
    categoria: row.category.slice(0,100), descripcion: description,
    duracion_min: row.duration_info.mode === 'fixed' ? row.duration_info.minutes : null,
    precio_base: null, origen: 'clinica', clinica_id: row.clinic_id, grupo_clinica_id: null,
    activo: 0, sesiones_defecto: 1, requiere_pieza: 0, requiere_zona: 0,
    clinical_config: config, appointment_automation_template_key: null, automation_template_bindings: null };
}
function verifyPlan(plan) {
  const { plan_sha256, ...body } = plan;
  if (hash(body) !== plan_sha256 || plan.version !== 1 || plan.mode !== 'catalog_dry_run_only'
    || plan.clinics.medical !== 72 || plan.clinics.capilar !== 66
    || !/^[a-f0-9]{64}$/.test(plan.workbook_sha256)) fail('CATALOG_PLAN_INTEGRITY_MISMATCH');
}
function prepareDraftPackage({ plan, before, now = new Date().toISOString() }) {
  verifyPlan(plan);
  const selected = plan.rows.filter(row => row.kind === 'treatment');
  if (!selected.length || selected.length > 250) fail('CATALOG_INDIVIDUAL_LIMIT');
  const codes = new Set(), operations = [], preserved = [];
  for (const row of selected) {
    const values = treatmentDraft(row);
    if (codes.has(values.codigo)) fail('CATALOG_DUPLICATE_SOURCE_CODE');
    codes.add(values.codigo);
    const found = before.treatments.filter(t => t.codigo === values.codigo);
    if (found.length > 1) fail('CATALOG_DUPLICATE_LOCAL_CODE');
    if (found.length) {
      const prior = found[0];
      const config = typeof prior.clinical_config === 'string' ? JSON.parse(prior.clinical_config) : prior.clinical_config;
      if (prior.clinica_id !== row.clinic_id || config?.source_catalog?.file_sha256 !== row.provenance.file_sha256
        || config?.source_catalog?.row_sha256 !== row.provenance.row_sha256) fail('CATALOG_EXISTING_SOURCE_REQUIRES_REVIEW');
      preserved.push({ id: prior.id_tratamiento, code: prior.codigo, before_sha256: hash(prior) });
    } else operations.push({ source_catalog_key: row.source_catalog_key, values, values_sha256: hash(values) });
  }
  const body = { version: VERSION, target: 'crm', group_id: 29, created_at: now,
    plan_sha256: plan.plan_sha256, workbook_sha256: plan.workbook_sha256, replies_sha256: plan.replies_sha256,
    resource_map_sha256: plan.resource_map_sha256, before, before_sha256: hash(before), operations, preserved,
    policy: { inactive_drafts_only: true, existing_records_untouched: true, price_base_unclassified: true,
      programs_and_bundles_separate: true, appointments_created: false, reminders_activated: false } };
  return { ...body, package_sha256: hash(body) };
}
function verifyDraftPackage(pkg, plan) {
  const expected = prepareDraftPackage({ plan, before: pkg.before, now: pkg.created_at });
  if (hash(pkg) !== hash(expected)) fail('CATALOG_DRAFT_PACKAGE_CHANGED');
}
module.exports = { VERSION, BATCH, areaFor, treatmentDraft, verifyPlan, prepareDraftPackage, verifyDraftPackage };
