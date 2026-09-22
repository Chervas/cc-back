'use strict';

// Offline, explicitly reviewed cosmetic modalities only. This is not a default
// tax policy for a specialty and never records a fictitious human approval.
const { hash } = require('./adapter');
const { verifyPlan } = require('./catalog-drafts');
const { normalizeProfile, breakdown } = require('../economicPriceProfile');
const VERSION = 'cliniccloud-catalog-cosmetic-prices/1';
const PROFILE = Object.freeze({ schema_version:1, price_semantics:'gross_tax_included', tax_percent:21, exemption_reason:null });
const LEGAL = Object.freeze([
  'https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740#a90',
  'https://sede.agenciatributaria.gob.es/Sede/ayuda/manuales-videos-folletos/manuales-practicos/manual-iva-2025/capitulo-03-entregas-realizadas-empresarios-profesionales/entregas-bienes-servic-realizadas-empresarios-profesionales/operaciones-exentas/exenciones-operaciones-interiores/exenciones-operaciones-medicas-sanitarias.html',
]);
const fail = code => { throw Error(code); };
const configOf = row => typeof row.clinical_config === 'string' ? JSON.parse(row.clinical_config) : row.clinical_config;
const canonical = row => ({ ...row, clinical_config:configOf(row) });

function prepareCosmeticPrices({ plan, review, purposeDocument, before, createdAt=new Date().toISOString() }) {
  verifyPlan(plan);
  if (review?.version !== 1 || review.scope !== 'explicit_non_therapeutic_cosmetic_modalities'
    || review.plan_sha256 !== plan.plan_sha256 || hash(purposeDocument) !== review.purpose_document_sha256
    || hash(review.profile) !== hash(PROFILE) || hash(review.legal_sources) !== hash(LEGAL)
    || !Array.isArray(review.bindings) || !review.bindings.length || review.bindings.length > 30
    || !Array.isArray(review.anchors) || review.anchors.length !== 2) fail('COSMETIC_PRICE_REVIEW_INVALID');
  if (before.clinics.length !== 1 || before.clinics[0].id_clinica !== 72 || Number(before.clinics[0].grupo_clinica_id) !== 29) fail('COSMETIC_PRICE_CLINIC_CHANGED');
  if (!Array.isArray(before.appointments) || before.appointments.length) fail('COSMETIC_PRICE_DRAFT_ALREADY_USED');
  if (before.anchors.length !== 2 || new Set(review.anchors.map(a=>a.codigo)).size !== 2) fail('COSMETIC_PRICE_ANCHORS_INVALID');
  for (const anchor of review.anchors) {
    const row = before.anchors.find(t=>t.codigo===anchor.codigo), cfg=row&&configOf(row);
    if (!row || hash(row)!==anchor.sha256 || row.clinica_id!==72 || cfg?.fiscal_mapping_pending!==false
      || !Number.isSafeInteger(cfg.imported_price_review?.reviewed_by) || cfg.imported_price_review.reviewed_by<=0
      || hash(normalizeProfile(cfg.price_profile))!==hash(PROFILE)
      || hash(cfg.imported_price_review.price_profile)!==hash(PROFILE)) fail('COSMETIC_PRICE_ANCHOR_CHANGED');
  }
  const operations=[], seen=new Set();
  for (const binding of review.bindings) {
    const sources=plan.rows.filter(r=>r.kind==='treatment' && r.source_catalog_key===binding.source_catalog_key);
    if (sources.length!==1) fail('COSMETIC_PRICE_SOURCE_NOT_UNIQUE');
    const source=sources[0];
    const found=before.treatments.filter(t=>t.codigo===source.proposed_code);
    if (found.length!==1 || seen.has(source.proposed_code)) fail('COSMETIC_PRICE_TREATMENT_NOT_UNIQUE');
    seen.add(source.proposed_code);
    const row=canonical(found[0]), cfg=row.clinical_config;
    // The first program examples predate source_catalog_key. Reconstruct their
    // exact original definition (including both source examples), not a fuzzy
    // name match or permission to accept missing provenance on other imports.
    const sourceKeyMatches=cfg?.source_catalog_key===source.source_catalog_key
      || (cfg?.source_catalog_key===undefined && cfg.import_batch==='cliniccloud-program-examples-20260914'
        && require('./program-examples').prepareProgramExamples(plan).some(example=>example.treatment.codigo===row.codigo
          && hash(example.treatment.clinical_config.source_catalog)===hash(cfg.source_catalog)));
    if (row.clinica_id!==72 || source.clinic_id!==72 || Number(row.activo)!==0 || cfg?.catalog_status!=='draft'
      || cfg.fiscal_mapping_pending!==true || row.precio_base!==null || cfg.imported_price_review || cfg.price_profile
      || row.nombre!==source.display_name || !sourceKeyMatches
      || hash(cfg.source_catalog)!==hash(source.provenance) || hash(found[0])!==binding.treatment_sha256) fail('COSMETIC_PRICE_DRAFT_CHANGED');
    const price=source.source_price, amount=price?.gross_amount;
    if (price?.mode!=='fixed' || price.includes_tax!==true || price.currency!=='EUR'
      || typeof amount!=='number' || !Number.isFinite(amount) || amount<=0 || amount>99999999.99
      || Math.round(amount*100)/100!==amount || hash(cfg.source_price)!==hash(price)) fail('COSMETIC_PRICE_FIXED_GROSS_REQUIRED');
    if (binding.classification!=='cosmetic_non_therapeutic' || typeof binding.reason!=='string' || binding.reason.length<40
      || typeof binding.source_quote!=='string' || binding.source_quote.length<8
      || ![source.category,source.name,source.detail].join(' ').includes(binding.source_quote)
      || typeof binding.purpose_quote!=='string' || binding.purpose_quote.length<25
      || !purposeDocument.includes(binding.purpose_quote)) fail('COSMETIC_PRICE_PURPOSE_EVIDENCE_REQUIRED');
    operations.push({ id:row.id_tratamiento, before:row, before_sha256:hash(row), gross_amount:amount,
      source_catalog_key:source.source_catalog_key, breakdown:breakdown(amount,PROFILE) });
  }
  if (before.treatments.length!==operations.length) fail('COSMETIC_PRICE_SCOPE_MISMATCH');
  const body={version:VERSION,target:'crm',group_id:29,clinic_id:72,created_at:createdAt,
    plan_sha256:plan.plan_sha256,review,review_sha256:hash(review),before,before_sha256:hash(before),operations,
    policy:{columns:['precio_base','clinical_config','updatedAt'],inactive_drafts_only:true,
      preserve_gross_price:true,therapeutic_exemptions_inferred:false,human_approval_attributed:false,
      treatments_activated:false,appointments_changed:false,budgets_changed:false,reminders_activated:false}};
  return {...body,package_sha256:hash(body)};
}
function reviewedConfig(op,pkg) {
  return {...op.before.clinical_config,price_profile:{...PROFILE},fiscal_mapping_pending:false,
    imported_price_review:{version:1,reviewed_at:pkg.created_at,reviewed_by:null,
      review_method:'documentary_import',gross_amount:op.gross_amount,price_profile:{...PROFILE},
      operator_review:{package_sha256:pkg.package_sha256,review_sha256:pkg.review_sha256,
        classification:'cosmetic_non_therapeutic',purpose_document_sha256:pkg.review.purpose_document_sha256}}};
}
function verifyCosmeticPrices(pkg,plan,purposeDocument) {
  const expected=prepareCosmeticPrices({plan,review:pkg.review,purposeDocument,before:pkg.before,createdAt:pkg.created_at});
  if(hash(expected)!==hash(pkg))fail('COSMETIC_PRICE_PACKAGE_CHANGED');
}
function verifyPricedState(after,pkg) {
  if(after.treatments.length!==pkg.operations.length)fail('COSMETIC_PRICE_AFTER_COUNT');
  const restored=[];
  for(const current of after.treatments) {
    const row=canonical(current),op=pkg.operations.find(o=>o.id===row.id_tratamiento);
    if(!op || Number(row.precio_base)!==op.gross_amount || hash(row.clinical_config)!==hash(reviewedConfig(op,pkg)))fail('COSMETIC_PRICE_AFTER_MISMATCH');
    const original={...row,precio_base:op.before.precio_base,clinical_config:op.before.clinical_config,updatedAt:op.before.updatedAt};
    if(hash(original)!==op.before_sha256)fail('COSMETIC_PRICE_UNRELATED_TREATMENT_CHANGE');
    restored.push(pkg.before.treatments.find(t=>t.id_tratamiento===op.id));
  }
  if(hash({...after,treatments:restored})!==pkg.before_sha256)fail('COSMETIC_PRICE_UNRELATED_CHANGE');
  return true;
}
module.exports={VERSION,PROFILE,LEGAL,prepareCosmeticPrices,reviewedConfig,verifyCosmeticPrices,verifyPricedState};
