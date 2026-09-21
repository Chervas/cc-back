'use strict';

const { haveSameTemplateComponents, normalizeTemplateComponentsForComparison } = require('./whatsapp-template-components');

const plain = value => value?.get ? value.get({ plain: true }) : (value || {});
const clean = value => String(value ?? '').trim();

function isApprovedTemplateInWaba(value, { wabaId, clinicId } = {}) {
  const row = plain(value);
  return !!clean(wabaId) && clean(row.waba_id) === clean(wabaId)
    && clean(row.status).toUpperCase() === 'APPROVED'
    && row.is_active !== false && Number(row.is_active) !== 0
    && !row.retired_at && !row.superseded_by_template_id
    && (!Number(row.clinic_id) || Number(row.clinic_id) === Number(clinicId));
}

// A clinic override is an editor/catalog reference, not proof that Meta approved
// it in the sender's WABA. Only an identical approved contract may replace it.
function selectTemplateInWaba(requested, candidates, scope) {
  const source = plain(requested);
  if (clean(source.status).toUpperCase() !== 'APPROVED'
    || source.is_active === false || Number(source.is_active) === 0
    || source.retired_at || source.superseded_by_template_id
    || Number(source.clinic_id) && Number(source.clinic_id) !== Number(scope.clinicId)) return null;
  if (isApprovedTemplateInWaba(requested, scope)) return requested;
  const catalogId = Number(source.catalog_template_id);
  const fromCatalog = Number.isSafeInteger(catalogId) && catalogId > 0;
  if (!fromCatalog && !clean(source.meta_template_id)) return null;
  if (!normalizeTemplateComponentsForComparison(source.components).some(component => component?.type === 'BODY' && component.text)) return null;
  return (candidates || []).filter(candidate => {
    const row = plain(candidate);
    return isApprovedTemplateInWaba(candidate, scope)
      && (fromCatalog ? Number(row.catalog_template_id) === catalogId
        : clean(row.meta_template_id) === clean(source.meta_template_id) && clean(row.name) === clean(source.name))
      && clean(row.language) === clean(source.language)
      && haveSameTemplateComponents(source.components, row.components);
  }).sort((left, right) => {
    const a = plain(left), b = plain(right);
    const exact = row => clean(row.meta_template_id) === clean(source.meta_template_id)
      && clean(row.name) === clean(source.name) ? 1 : 0;
    return exact(b) - exact(a) || Number(b.id) - Number(a.id);
  })[0] || null;
}

module.exports = { isApprovedTemplateInWaba, selectTemplateInWaba };
