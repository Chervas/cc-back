'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SCHEDULED_JOB_DEFINITIONS,
  BACKGROUND_INTEGRATION_JOB_TYPES,
} = require('../../config/scheduledJobCatalog');

const routes = fs.readFileSync(path.resolve(__dirname, '../../routes/marketing.routes.js'), 'utf8');
const executor = fs.readFileSync(path.resolve(__dirname, '../../services/jobExecutor.service.js'), 'utf8');
const authIndex = routes.indexOf('router.use(authMiddleware)');
assert.ok(authIndex > 0);
for (const publicRoute of [
  "'/web-installations/:installationId/desired-state'",
  "'/web-installations/:installationId/reports'",
  "'/web-installations/:installationId/artifacts/:artifactHash/manifest'",
]) {
  const routeIndex = routes.indexOf(publicRoute);
  assert.ok(routeIndex > 0 && routeIndex < authIndex, `${publicRoute} must remain before UI authentication`);
}
for (const authenticatedRoute of [
  "router.get('/web-projects'",
  "router.post('/web-publications'",
  "router.get('/strategies/:id/destination-bindings'",
  "router.post('/destination-bindings/:bindingId/apply'",
  "router.post('/destination-bindings/:bindingId/rollback'",
]) {
  assert.ok(routes.indexOf(authenticatedRoute) > authIndex, `${authenticatedRoute} must remain authenticated`);
}

assert.equal(typeof SCHEDULED_JOB_DEFINITIONS.webDomainReconciliation, 'object');
assert.equal(typeof SCHEDULED_JOB_DEFINITIONS.campaignDestinationDriftAudit, 'object');
for (const jobType of [
  'marketing_web.landing_published.v1',
  'marketing_web.destination_ready.v1',
  'marketing_campaign.destination_apply.v1',
  'marketing_campaign.destination_rollback.v1',
  'guided_campaign_goal_policy_apply',
  'web_publication_deploy',
]) {
  const handlerToken = jobType.includes('.') ? `'${jobType}':` : `${jobType}:`;
  assert.ok(executor.includes(handlerToken), `${jobType} handler missing`);
}
for (const providerJob of [
  'marketing_campaign.destination_apply.v1',
  'marketing_campaign.destination_rollback.v1',
  'guided_campaign_goal_policy_apply',
]) {
  assert.equal(
    BACKGROUND_INTEGRATION_JOB_TYPES.includes(providerJob),
    true,
    `${providerJob} must use provider lane`,
  );
}

console.log('marketing web/campaign integration: ok');
