'use strict';

const { REVIEW_AUTOMATION_ACTION } = require('./review-automation-config');

function isActive(template) {
  return template?.is_active === true || Number(template?.is_active) === 1;
}

function isReviewAutomation(template) {
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  return nodes.some((node) => String(node?.type || '') === REVIEW_AUTOMATION_ACTION);
}

function selectCatalogSourceCandidates(templates) {
  const rows = Array.isArray(templates) ? templates : [];
  const active = rows.filter(isActive);
  if (active.length) return active;

  // Review masters stay inactive because activation belongs to each clinic.
  return rows.filter(isReviewAutomation);
}

module.exports = {
  isReviewAutomation,
  selectCatalogSourceCandidates,
};
