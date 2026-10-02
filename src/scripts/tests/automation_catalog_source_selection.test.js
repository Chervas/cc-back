'use strict';

const assert = require('node:assert/strict');
const {
  selectCatalogSourceCandidates,
} = require('../../lib/automation-catalog-source-selection');

const reviewNode = { type: 'action/request_review', config: {} };
const ordinaryNode = { type: 'action/send_whatsapp', config: {} };

const activeOrdinary = { id: 1, is_active: true, nodes: [ordinaryNode] };
const inactiveReview = { id: 2, is_active: false, nodes: [reviewNode] };
const inactiveOrdinary = { id: 3, is_active: false, nodes: [ordinaryNode] };
const inactiveLead = {
  id: 4, is_active: false, nodes: [ordinaryNode],
  trigger_config: { managed_feature: 'lead_auto_reply', configured: false },
};

assert.deepEqual(
  selectCatalogSourceCandidates([inactiveReview, activeOrdinary]),
  [activeOrdinary],
  'an active source remains preferable to every inactive source',
);
assert.deepEqual(
  selectCatalogSourceCandidates([inactiveReview]),
  [inactiveReview],
  'an inactive review master remains eligible for clinic propagation',
);
assert.deepEqual(
  selectCatalogSourceCandidates([inactiveOrdinary]),
  [],
  'an inactive ordinary automation must not be propagated',
);
assert.deepEqual(selectCatalogSourceCandidates([inactiveLead]), [inactiveLead],
  'an unconfigured managed lead source can be propagated without activating it');
assert.deepEqual(selectCatalogSourceCandidates([inactiveLead, activeOrdinary]), [activeOrdinary],
  'inactive managed sources do not supersede an active source');

console.log('automation_catalog_source_selection.test.js: OK');
