'use strict';

const { hash, norm } = require('./adapter');
const VERSION = 'cliniccloud-catalog-retirement/1';
const SOURCE_BATCH = 'cliniccloud_bsmedical_real_20260726';
const DEMO_BATCH = 'cliniccloud_demo_20260722';
const SINCE = '2026-09-21'; // Preserve the complete launch week, not merely today.
const fail = code => { throw Error(code); };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

function exactLegacySource(treatment) {
  const config = decode(treatment.clinical_config);
  return [66,72].includes(treatment.clinica_id) && treatment.origen === 'clinica'
    && config?.source_system === 'cliniccloud' && config.source_batch === SOURCE_BATCH
    && treatment.codigo === `CCLOUD-${config.raw?.idServicio}`
    && config.source_reference === `service:${config.raw?.idServicio}`
    && !!norm(treatment.nombre) && norm(treatment.nombre) === norm(config.raw?.nombre);
}

function inspect({ before, source }) {
  const kind = source?.catalogue_kind || 'legacy';
  if (source?.since !== SINCE || !/^[a-f0-9]{64}$/.test(source?.zip_sha256 || '')
    || !['legacy','demo'].includes(kind)
    || !Array.isArray(source.services) || !source.services.length
    || source.services.some(s => typeof s !== 'string')
    || hash(before.clinics) !== hash([{ id_clinica:66, grupo_clinica_id:29 }, { id_clinica:72, grupo_clinica_id:29 }])
    || !Array.isArray(before.treatments) || !before.treatments.length || before.treatments.length > (kind === 'demo' ? 100 : 250)
    || (kind === 'demo' && (!Array.isArray(before.canonical_treatments) || !before.canonical_treatments.length || before.canonical_treatments.length > 250))) fail('RETIREMENT_SCOPE_INVALID');
  const services = source.services.map(norm), eligible = [], retained = [];
  for (const treatment of before.treatments) {
    const id = treatment.id_tratamiento, config = decode(treatment.clinical_config);
    const reasons = [];
    if (kind === 'legacy') {
      if (!exactLegacySource(treatment)) reasons.push('source_not_exact');
      // Substring matching only protects records; it never maps services.
      if (services.some(s => s.includes(norm(treatment.nombre)))) reasons.push('service_in_latest_source_interval');
    } else {
      if (![66,72].includes(treatment.clinica_id) || treatment.origen !== 'clinica'
        || config?.source_system !== 'cliniccloud' || config.demo !== true || config.import_batch !== DEMO_BATCH
        || !/^\d+$/.test(String(config.source_service_id)) || treatment.codigo !== `CCIMP-${config.source_service_id}`
        || treatment.createdAt !== treatment.updatedAt) reasons.push('demo_source_not_exact_or_edited');
      const matches = before.canonical_treatments.filter(t => exactLegacySource(t)
        && String(decode(t.clinical_config).raw.idServicio) === String(config?.source_service_id));
      if (matches.length !== 1 || norm(matches[0].nombre) !== norm(treatment.nombre)) reasons.push('canonical_counterpart_not_exact');
      // The delta names the source service, not the demo-local ID. It is safe
      // to hide an unreferenced duplicate only if its exact real counterpart
      // still supplies that service. We never move any references to it.
      if (services.some(s => s.includes(norm(treatment.nombre))) && (matches.length !== 1
        || Number(matches[0].activo) !== 1 || ['draft','obsolete'].includes(decode(matches[0].clinical_config)?.catalog_status))) reasons.push('canonical_service_not_available');
    }
    if (Number(treatment.activo) !== 1 || config?.catalog_status != null) reasons.push('catalogue_already_changed');
    if (before.appointment_usage.some(r => r.treatment_id === id && r.recent_count > 0)) reasons.push('appointment_in_launch_week_or_later');
    for (const r of before.references) if (r.treatment_id === id) reasons.push(r.kind);
    if (reasons.length) retained.push({ id, code:treatment.codigo, reasons:[...new Set(reasons)].sort() });
    else eligible.push(id);
  }
  return { eligible, retained };
}

function prepare({ before, source, createdAt = new Date().toISOString() }) {
  const inspected = inspect({ before, source });
  const operations = inspected.eligible.map(id => {
    const row = before.treatments.find(t => t.id_tratamiento === id);
    return { id, before_sha256:hash(row), after:{ ...row, activo:0,
      clinical_config:{ ...decode(row.clinical_config), catalog_status:'obsolete',
        source_catalog_retirement:{ version:VERSION, retired_at:createdAt,
          reason:source.catalogue_kind === 'demo'
            ? 'Duplicate demo catalogue retained as history; exact canonical source service verified. No references rewritten.'
            : 'Superseded catalogue retained as history; no current/source appointment or dependent commercial object.',
          source_zip_sha256:source.zip_sha256, protected_since:SINCE, previous_sha256:hash(row),
          replacement_treatment_id:null } } } };
  });
  const body = { version:VERSION, target:'crm', created_at:createdAt, before, before_sha256:hash(before), source,
    operations, retained:inspected.retained,
    policy:{ appointments_changed:false, history_changed:false, prices_changed:false, vouchers_changed:false,
      equivalences_created:false, reminders_activated:false, records_deleted:false } };
  return { ...body, package_sha256:hash(body) };
}

function verifyPackage(pkg) {
  if (hash(prepare({ before:pkg.before, source:pkg.source, createdAt:pkg.created_at })) !== hash(pkg)) fail('RETIREMENT_PACKAGE_CHANGED');
}

function verifyAfter(after, pkg) {
  if (after.treatments.length !== pkg.before.treatments.length) fail('RETIREMENT_AFTER_COUNT');
  for (const row of after.treatments) {
    const previous = pkg.before.treatments.find(t => t.id_tratamiento === row.id_tratamiento);
    const op = pkg.operations.find(o => o.id === row.id_tratamiento);
    if (!previous || hash(op ? { ...row, updatedAt:op.after.updatedAt } : row) !== hash(op?.after || previous)) fail('RETIREMENT_AFTER_CHANGED');
  }
  if (hash({ ...after, treatments:pkg.before.treatments }) !== pkg.before_sha256) fail('RETIREMENT_DEPENDENCIES_CHANGED');
  return true;
}

// Only explicitly named treatment keys count. Never treat a patient's ID,
// quantity, amount or machine ID as a treatment reference.
const referenceKeys = new Set(['treatment_id','treatment_ids','tratamiento_id','tratamientoId','id_tratamiento','catalogoId','target_treatment_id']);
function referencedTreatmentIds(value, candidates) {
  const found = new Set();
  function ids(v) {
    if (Array.isArray(v)) return v.forEach(ids);
    if (['string','number'].includes(typeof v) && /^\d+$/.test(String(v)) && candidates.has(Number(v))) found.add(Number(v));
  }
  function visit(v) {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    for (const [key,item] of Object.entries(v)) { if (referenceKeys.has(key)) ids(item); visit(item); }
  }
  visit(decode(value)); return [...found].sort((a,b)=>a-b);
}

module.exports = { VERSION, SOURCE_BATCH, DEMO_BATCH, SINCE, inspect, prepare, verifyPackage, verifyAfter, referencedTreatmentIds };
