'use strict';

const assert = require('assert');
const {
  inspectExplicitReviewAutomation,
  normalizeReviewDelay,
  reviewDelayToHours,
} = require('../../lib/review-automation-config');

function buildTemplate(overrides = {}) {
  return {
    id: 10,
    clinic_id: 66,
    group_id: null,
    is_system: false,
    trigger_type: 'appointment_completed',
    trigger_config: {
      event_name: 'appointment_completed',
      managed_feature: 'review_request',
      configured: true,
      configuration_version: 1,
      review_source: 'completed_treatment',
      review_delay: '24h',
      initial_delay_hours: 24,
    },
    is_active: true,
    published_at: new Date('2026-08-06T09:00:00.000Z'),
    nodes: [
      { type: 'delay/fixed', config: { duration: 24, unit: 'hours' } },
      {
        type: 'action/request_review',
        config: {
          review_source: 'completed_treatment',
          whatsapp_template_id: 462,
          review_sender_name: 'Lidia',
        },
      },
    ],
    ...overrides,
  };
}

assert.equal(normalizeReviewDelay('1d'), '24h');
assert.equal(reviewDelayToHours('7d'), 168);

const valid = inspectExplicitReviewAutomation(buildTemplate(), {
  clinicId: 66,
  requireActive: true,
});
assert.equal(valid.configured, true);
assert.equal(valid.review_delay, '24h');

const globalTemplate = inspectExplicitReviewAutomation(buildTemplate({ clinic_id: null, is_system: true }), {
  clinicId: 66,
  requireActive: true,
});
assert.equal(globalTemplate.configured, false);
assert(globalTemplate.errors.includes('clinic_scope_missing'));

const propagatedCopy = buildTemplate({
  trigger_config: { event_name: 'appointment_completed' },
});
const propagatedInspection = inspectExplicitReviewAutomation(propagatedCopy, {
  clinicId: 66,
  requireActive: true,
});
assert.equal(propagatedInspection.configured, false);
assert(propagatedInspection.errors.includes('explicit_configuration_missing'));

const mismatchedDelay = buildTemplate({
  nodes: [
    { type: 'delay/fixed', config: { duration: 48, unit: 'hours' } },
    buildTemplate().nodes[1],
  ],
});
const mismatchedInspection = inspectExplicitReviewAutomation(mismatchedDelay, {
  clinicId: 66,
  requireActive: true,
});
assert.equal(mismatchedInspection.configured, false);
assert(mismatchedInspection.errors.includes('review_delay_mismatch'));

console.log('review_automation_config.test.js: OK');
