'use strict';
const { catalogError } = require('./treatment-catalog-contract');
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const hash = value => require('./cliniccloud-import/adapter').hash(value);
function config(treatment) { return object((treatment?.toJSON ? treatment.toJSON() : treatment)?.clinical_config); }
function saleMode(treatment) {
  const mode = object(config(treatment).commercial).sale_mode;
  if (mode == null || mode === 'standalone') return 'standalone';
  if (mode !== 'program_component_only') throw catalogError('Modalidad comercial no válida.', 'treatment_sale_mode_invalid');
  return mode;
}
function componentEvidence(treatment) {
  const value = treatment?.toJSON ? treatment.toJSON() : treatment;
  const cfg = config(value);
  const source = cfg.source_price;
  const imported = source != null || cfg.import_batch != null || cfg.source_catalog != null;
  if (imported && (!source || source.mode !== 'included' || source.gross_amount != null)) {
    throw catalogError('La fuente importada debe indicar expresamente que este componente está incluido y no tiene tarifa individual.', 'component_import_source_invalid', 422);
  }
  return { treatment_id: Number(value?.id_tratamiento) || null,
    scope: { origin: value?.origen || 'clinica', clinic_id: Number(value?.clinica_id) || null, group_id: Number(value?.grupo_clinica_id) || null },
    source_price_sha256: source == null ? null : hash(source), standalone_amount: null };
}
function componentApproved(treatment) {
  try {
    const value = treatment?.toJSON ? treatment.toJSON() : treatment;
    if (saleMode(value) !== 'program_component_only' || value?.precio_base !== null) return false;
    const review = object(object(config(treatment).commercial).component_review);
    const evidence = componentEvidence(treatment);
    return review.schema_version === 1 && Number.isSafeInteger(review.approved_by) && review.approved_by > 0
      && typeof review.approved_at === 'string' && Number.isFinite(Date.parse(review.approved_at))
      && review.evidence_sha256 === hash(evidence) && hash(review.evidence) === hash(evidence);
  } catch { return false; }
}
function mergeCommercialConfig(previous, next) {
  const result = { ...next }, commercial = { ...object(next.commercial) };
  const previousReview = object(previous?.commercial).component_review;
  if (previousReview) commercial.component_review = previousReview;
  else delete commercial.component_review;
  if (commercial.sale_mode != null && !['standalone', 'program_component_only'].includes(commercial.sale_mode)) {
    throw catalogError('Modalidad comercial no válida.', 'treatment_sale_mode_invalid');
  }
  if (Object.keys(commercial).length) result.commercial = commercial;
  else delete result.commercial;
  return result;
}
function assertNoClientImportEvidence(previous, incoming) {
  previous = object(previous); incoming = object(incoming);
  for (const key of Object.keys(incoming).filter(key => key.startsWith('source_') || ['import_batch', 'import_source'].includes(key))) {
    if (!Object.hasOwn(previous, key)) throw catalogError('La procedencia importada sólo la puede registrar el importador, no el formulario del catálogo.', 'component_import_source_untrusted', 422);
  }
}
function approveComponent(treatment, { confirm, actorId, now = new Date() } = {}) {
  treatment = treatment?.toJSON ? treatment.toJSON() : treatment;
  if (confirm != null && typeof confirm !== 'boolean') throw catalogError('La aprobación del componente debe ser explícita.', 'component_confirmation_invalid');
  if (saleMode(treatment) !== 'program_component_only') {
    if (confirm === true) throw catalogError('Esta aprobación es sólo para componentes incluidos.', 'component_confirmation_invalid');
    return config(treatment);
  }
  if (treatment.precio_base !== null) throw catalogError('Un componente incluido debe conservar la tarifa individual sin definir; no pongas cero.', 'component_standalone_price_forbidden', 422);
  if (confirm !== true) return config(treatment);
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) throw catalogError('Falta el usuario que aprueba el componente.', 'component_actor_required', 401);
  const evidence = componentEvidence(treatment);
  if (!evidence.treatment_id) throw catalogError('Guarda el componente antes de aprobarlo.', 'component_identity_required', 409);
  return { ...config(treatment), commercial: { ...object(config(treatment).commercial), sale_mode: 'program_component_only', component_review: {
    schema_version: 1, approved_by: Number(actorId), approved_at: now.toISOString(), evidence, evidence_sha256: hash(evidence),
  } } };
}
function policy(treatment) {
  const mode = saleMode(treatment), approved = mode === 'program_component_only' && componentApproved(treatment);
  return { sale_mode: mode, component_approved: approved, requires_component_approval: mode === 'program_component_only' && !approved };
}
function assertStandalone(treatment) {
  if (saleMode(treatment) === 'program_component_only') throw catalogError('Este tratamiento está incluido en programas y no se vende por separado.', 'treatment_program_component_only', 422);
}
module.exports = { saleMode, componentApproved, mergeCommercialConfig, approveComponent, policy, assertStandalone, assertNoClientImportEvidence };
