'use strict';

const { REVIEW_AUTOMATION_ACTION } = require('./review-automation-config');

function isActive(template) {
  return template?.is_active === true || Number(template?.is_active) === 1;
}

function isReviewAutomation(template) {
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  return nodes.some((node) => String(node?.type || '') === REVIEW_AUTOMATION_ACTION);
}

function isManagedLeadAutomation(template) {
  return template?.trigger_config?.managed_feature === 'lead_auto_reply';
}

function selectCatalogSourceCandidates(templates) {
  const rows = Array.isArray(templates) ? templates : [];
  const active = rows.filter(isActive);
  if (active.length) return active;

  // Managed masters stay inactive because configuration and activation are local.
  return rows.filter((template) => isReviewAutomation(template) || isManagedLeadAutomation(template));
}

module.exports = {
  isReviewAutomation,
  isManagedLeadAutomation,
  selectCatalogSourceCandidates,
};
