'use strict';

// Preserve the Meta identity of the approved Spanish copy when publishing it
// for Propdental. Unlinked personal copies retain their existing ownership.
const PROPDENTAL_GROUP_ID = 5;
const AVAILABILITY_FAMILY = 'cc_custom_039a98536affe8375a416b00b6629028ff59f2ed';

function isPropdentalAvailabilityCatalog(catalog) {
  return catalog?.family_key === AVAILABILITY_FAMILY;
}

function isPropdentalAvailabilityInstance(template) {
  if (!Number(template?.catalog_template_id)) return false;
  const name = String(template.name || '');
  return name === AVAILABILITY_FAMILY
    || (name.startsWith(AVAILABILITY_FAMILY + '_v') && /^[1-9]\d*$/.test(name.slice(AVAILABILITY_FAMILY.length + 2)));
}

function templateBelongsToClinic(template, clinic) {
  return !isPropdentalAvailabilityInstance(template) || Number(clinic?.grupoClinicaId) === PROPDENTAL_GROUP_ID;
}

module.exports = { PROPDENTAL_GROUP_ID, AVAILABILITY_FAMILY, isPropdentalAvailabilityCatalog,
  isPropdentalAvailabilityInstance, templateBelongsToClinic };
