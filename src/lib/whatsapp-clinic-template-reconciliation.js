'use strict';

const { createHash } = require('node:crypto');
const { normalizeTemplateComponentsForComparison } = require('./whatsapp-template-components');
const plain = row => row?.get ? row.get({ plain: true }) : row;
const active = row => row?.is_active === true || row?.is_active === 1;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function contract(row) {
  row = plain(row);
  return createHash('sha256').update(JSON.stringify(canonical({ category: row.category,
    language: row.language, components: normalizeTemplateComponentsForComparison(row.components), variables: row.variables }))).digest('hex');
}
function isSource(row, clinicId) {
  return Number(row?.clinic_id) === Number(clinicId) && row.origin === 'custom' && !row.catalog_template_id
    && Number(row.created_by_user_id) > 0 && active(row) && !row.retired_at && !row.superseded_by_template_id
    && row.name && row.language && Array.isArray(row.components) && row.components.some(c => c.type === 'BODY' && c.text);
}
function planClinicTemplates({ clinicId, wabaId, sources, targets }) {
  const groups = new Map(), plan = [], reviews = [];
  const identity = row => JSON.stringify([row.created_by_user_id, row.name, row.language]);
  const retired = new Set(sources.map(plain).filter(row => Number(row.clinic_id) === Number(clinicId)
    && row.origin === 'custom' && (!active(row) || row.retired_at || row.superseded_by_template_id)).map(identity));
  for (const row of sources.map(plain).filter(row => isSource(row, clinicId) && row.meta_template_id
    && ['APPROVED', 'PENDING', 'IN_REVIEW'].includes(row.status))) {
    const key = identity(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    if (retired.has(identity(rows[0]))) {
      reviews.push({ reason: 'clinic_template_identity_retired_elsewhere', source_ids: rows.map(row => row.id) }); continue;
    }
    if (new Set(rows.map(contract)).size > 1) {
      reviews.push({ reason: 'clinic_template_copies_diverged', source_ids: rows.map(row => row.id) }); continue;
    }
    const source = rows.sort((a, b) => Number(a.id) - Number(b.id))[0];
    const target = targets.map(plain).find(row => row.name === source.name && row.language === source.language);
    if (target && (!isSource(target, clinicId) || Number(target.created_by_user_id) !== Number(source.created_by_user_id)
      || contract(target) !== contract(source))) {
      reviews.push({ reason: 'clinic_template_target_conflict', source_ids: [source.id], target_id: target.id }); continue;
    }
    const equivalent = targets.map(plain).find(row => isSource(row, clinicId)
      && Number(row.created_by_user_id) === Number(source.created_by_user_id)
      && (row.display_name || row.name) === (source.display_name || source.name) && contract(row) === contract(source));
    if (equivalent && equivalent.name !== source.name) {
      reviews.push({ reason: 'clinic_template_equivalent_unlinked', source_ids: [source.id], target_id: equivalent.id }); continue;
    }
    if (equivalent && equivalent.rejection_reason !== 'custom_submission_not_started') continue;
    if (String(source.waba_id || '') === String(wabaId)) continue;
    plan.push({ source, fingerprint: contract(source), existing: target || equivalent || null });
  }
  return { plan, reviews };
}

module.exports = { contract, isSource, planClinicTemplates };
