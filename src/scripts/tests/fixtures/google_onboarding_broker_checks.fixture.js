'use strict';
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');

// Actual controller readiness path with owned MySQL and the signed broker.
// The internal audit caller has no user session: this is not authenticated UI QA.
module.exports = async ({ models, sql, report, broker, mapping, writes, calls, validations, setAfterRemote }) => {
  const B = require('../../../services/googleAdsBroker.service');
  const original = Object.fromEntries(['prepare', 'assert', 'read', 'conversion'].map(key => [key, B[key]]));
  const envKeys = ['GOOGLE_DATA_MANAGER_QUOTA_PROJECT', 'GOOGLE_CLOUD_PROJECT'];
  const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(original)) B[key] = broker[key];
    envKeys.forEach(key => { delete process.env[key]; });
    for (const [table, fields] of [
      ['Clinicas', { nombre_clinica: D.STRING, url_web: D.STRING }],
      ['GruposClinicas', { nombre_grupo: D.STRING, ads_assignment_mode: D.STRING, web_assignment_mode: D.STRING, web_primary_url: D.STRING }],
    ]) for (const [name, type] of Object.entries(fields)) await sql.getQueryInterface().addColumn(table, name, { type });
    // Explicit attributes in the real scope resolver can query these columns
    // without changing the existing minimal model definitions.
    const controller = require('../../../controllers/campaignOnboarding.controller');
    const readiness = controller.__test.evaluateGoogleConversionOnboardingReadiness;
    const scope = { assignment_scope: 'clinic', clinic_id: 71, group_id: 5, clinic_ids: [71] };
    const config = { enabled: true, customer_id: mapping.customerId, currency: 'EUR',
      events: { lead: { enabled: true, conversion_action_id: '456' }, contact: { enabled: false },
        qualified_lead: { enabled: false }, schedule: { enabled: false }, purchase: { enabled: false } } };
    const run = (extra = {}) => readiness({ userId: null, scope, rawGoogleAdsConfig: config,
      fallbackCustomerId: mapping.customerId, consentReadiness: { ready: true, validated: true, issues: [] }, ...extra });
    const count = writes(), before = validations.length;
    const result = await run();
    assert.equal(result.ready, true, JSON.stringify(result)); assert.equal(result.validated, true);
    assert.equal(result.capabilities_by_customer[mapping.customerId].data_manager_quota_project_configured, true);
    assert.equal(validations.length, before + 1); assert.equal(writes(), count);
    assert.equal(result.created_actions.length, 0);
    assert(validations.slice(before).every(body => body.validateOnly === true && !body.events[0].userData));
    report.checks.push('actual onboarding readiness controller resolves a clinic inside a managed group, lists canonical actions and confirms remote quota by signed validate-only with no local quota setting or ingestion');

    const missing = structuredClone(config); missing.events.contact = { enabled: true };
    const beforeMissing = validations.length;
    const pending = await run({ rawGoogleAdsConfig: missing, createMissing: true });
    assert.equal(pending.ready, false); assert(pending.reasons.includes('google_conversion_action_broker_provisioning_pending'));
    assert.equal(writes(), count); assert.equal(validations.length, beforeMissing);
    report.checks.push('a missing canonical action with requested creation remains explicitly pending and cannot enter local-token provisioning or claim readiness');

    const clinic = await models.Clinica.findByPk(71);
    await clinic.update({ estado_clinica: false });
    const beforePause = calls(), paused = await run();
    assert.equal(paused.ready, false); assert.equal(calls(), beforePause); assert.equal(writes(), count);
    await clinic.update({ estado_clinica: true });
    report.checks.push('actual onboarding controller rejects a paused SQL clinic before broker access without reading tokens');

    setAfterRemote(async command => {
      if (command.operation !== 'google.ads.conversion.validate.v1') return;
      setAfterRemote(null); await clinic.update({ estado_clinica: false });
    });
    const revoked = await run();
    assert.equal(revoked.ready, false); assert.equal(revoked.validated, false); assert.equal(writes(), count);
    await clinic.update({ estado_clinica: true });
    const recovered = await run(); assert.equal(recovered.ready, true); assert.equal(writes(), count);
    report.checks.push('a SQL clinical pause during signed validate-only invalidates onboarding readiness; restoring the fixture permits a new read-only check without sending an event');
  } finally {
    setAfterRemote(null); Object.assign(B, original);
    for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  }
};
