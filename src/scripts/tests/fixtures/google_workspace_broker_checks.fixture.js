'use strict';
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
const { randomUUID, createHash } = require('node:crypto');

// Invoked only inside the owned MySQL/socket fixture. These are real SQL models
// for the fields read by the services; only Google/AWS transport is fictitious.
module.exports = async ({ models, sql, report, broker, mapping, now, writes, calls, validations, setAfterRemote, setBeforeRemote, setProviderMode }) => {
  const B = require('../../../services/googleAdsBroker.service');
  const previous = B.forModels;
  B.forModels = requested => { assert.equal(requested, models); return broker; };
  Object.assign(process.env, { GOOGLE_ADS_BROKER_ENABLED: 'true', GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED: 'true',
    CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' });
  const define = async (name, fields, tableName) => {
    const value = sql.define(name, fields, { tableName, timestamps: false }); models[name] = value; await value.sync(); return value;
  };
  try {
    models.GrupoClinica = sql.define('GrupoClinica', { id_grupo: { type: D.INTEGER, primaryKey: true } }, { tableName: 'GruposClinicas', timestamps: false });
    for (const [name, file] of [['CampaignWorkspaceSetting', 'campaignworkspacesetting'], ['CampaignWorkspaceEvent', 'campaignworkspaceevent']]) {
      models[name] = require('../../../../models/' + file)(sql, D); await models[name].sync();
    }
    await define('ExternalCampaignAssignment', { provider: D.STRING, customer_id: D.STRING, campaign_id: D.STRING,
      status: D.STRING, clinica_id: D.INTEGER }, 'ExternalCampaignAssignments');
    await define('LeadIntake', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, grupo_clinica_id: D.INTEGER,
      source: D.STRING, source_detail: D.STRING, external_source: D.STRING, external_id: D.STRING,
      google_ads_customer_id: D.STRING, google_ads_campaign_id: D.STRING, consentimiento_canal: D.JSON,
      status_lead: D.STRING, archived_at: D.DATE, gclid: D.STRING, email: D.STRING, telefono: D.STRING }, 'LeadIntakes');
    await define('LeadAttributionAudit', { lead_intake_id: D.INTEGER, attribution_steps: D.JSON, raw_payload: D.JSON }, 'LeadAttributionAudits');
    await define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, lead_intake_id: D.INTEGER,
      clinica_id: D.INTEGER, es_provisional: D.BOOLEAN, estado: D.STRING }, 'CitasPacientes');

    const scope = { clinicIds: [71], groupId: null }, events = ['lead', 'qualified_lead', 'schedule'];
    const accounts = [{ provider: 'google_ads', account_id: mapping.customerId, include_future: true, campaign_ids: [] }];
    const settings = models.CampaignWorkspaceSetting;
    const setting = await settings.create({ id: 'fictitious-workspace', scope_type: 'clinic', scope_id: 71,
      version: 1, accounts, preferences: { mode: 'measurement', signals: { enabled: true, events } }, updated_by_user_id: 2 });
    const preparation = require('../../../services/campaignWorkspaceGooglePreparation.service');
    const authorization = require('../../../services/campaignWorkspaceSignalAuthorization.service');
    const grant = require('../../../services/googleAdsGrantTransport.service');
    const getSetting = () => settings.findByPk(setting.id);
    const prepare = async () => preparation.checkGooglePreparation({ models, scope, actorId: 2, now,
      hasAccess: async () => true, input: { account_id: mapping.customerId, expected_version: (await getSetting()).version },
      ensureToken: () => assert.fail('managed preparation must not obtain a local token'),
      list: () => assert.fail('managed preparation must not use a legacy search'),
      upload: () => assert.fail('managed preparation must not use legacy Data Manager') });
    const beforeValidation = writes(); const result = await prepare();
    assert.equal(result.preparation.status, 'checked');
    assert(result.preparation.events.every(row => row.state === 'verified'));
    assert.equal(validations.length, 5); assert.equal(writes(), beforeValidation);
    assert(validations.every(body => body.validateOnly && body.events[0].adIdentifiers.gclid === 'GCLID_1'));
    assert.equal(validations.filter(body => body.events[0].eventSource === 'OTHER').length, 2);
    report.checks.push('actual workspace preparation lists actions through the signed Ads broker and validates web/native origins with five fictitious validate-only calls and no event ingestion');

    await require('./google_onboarding_broker_checks.fixture')({ models, sql, report, broker, mapping, writes, calls, validations, setAfterRemote });

    const context = await preparation.googlePreparationContext({ models, scope, accountId: mapping.customerId });
    assert(context.brokerGrant); assert(!Object.hasOwn(context.connection, 'accessToken'));
    await assert.rejects(grant.assertGoogleAdsGrantTransport({}), { code: 'broker_binding_invalid' });
    await assert.rejects(grant.assertGoogleAdsGrantTransport(JSON.parse(JSON.stringify(context.brokerGrant))), { code: 'broker_binding_invalid' });
    await assert.rejects(grant.assertGoogleAdsGrantTransport(context.brokerGrant, { clinicId: 99 }), { code: 'scope_denied' });
    const review = await authorization.loadSignalAuthorizationReview({ models, scope, setting: await getSetting(), now: now() });
    assert.equal(review.review.ready, true); assert.equal(review.authorization.destinations.length, 1);
    assert(!JSON.stringify(review).includes('brokerGrant')); assert(!JSON.stringify(review).includes('accessToken'));
    const grantRow = await models.GoogleConnection.findByPk(context.connection.id, { attributes: ['id', 'googleUserId', 'scopes'] });
    const originalScopes = grantRow.scopes, originalSubject = grantRow.googleUserId;
    await grantRow.update({ scopes: 'https://www.googleapis.com/auth/adwords' });
    await assert.rejects(grant.assertGoogleAdsGrantTransport(context.brokerGrant), { code: 'broker_binding_invalid' });
    await assert.rejects(preparation.googlePreparationContext({ models, scope, accountId: mapping.customerId }), { code: 'workspace_google_permissions_required' });
    await grantRow.update({ scopes: originalScopes, googleUserId: 'replaced-fictitious-subject' });
    await assert.rejects(grant.assertGoogleAdsGrantTransport(context.brokerGrant), { code: 'broker_binding_invalid' });
    await grantRow.update({ googleUserId: originalSubject });
    assert.equal(writes(), beforeValidation);
    report.checks.push('removing Data Manager scope or replacing the Google subject invalidates captured workspace grants before transport without reading local credentials');
    // Seed an authorized fixture from the real review; this is not a UI or
    // administrator-authentication test and does not activate a real workspace.
    const activation = { schema_version: 2, status: 'active', mode: 'measurement',
      signals: { enabled: true, events, authorization: review.authorization }, account_authorizations: accounts };
    await setting.update({ activation, version: (await getSetting()).version + 1 });
    report.checks.push('workspace review remains token-free and runtime accepts only an in-process grant with a currently authorized clinic, rejecting fabricated or serialized grants');

    const cfg = await models.IntakeConfig.findByPk(1);
    const dependencies = { models, now, ensureToken: () => assert.fail('no local OAuth in managed workspace'),
      uploadConversion: () => assert.fail('no legacy event transport in managed workspace') };
    const web = () => ({ cfgRecord: cfg, clinicId: 71, eventName: 'lead', eventId: randomUUID(),
      customData: { customer_id: mapping.customerId, campaign_id: '200', gclid: 'FICTITIOUS-CLICK' },
      consent: { ad_user_data: 'granted', ad_personalization: 'denied' }, dependencies });
    const uploadWeb = require('../../../services/campaignWorkspaceGoogleConversion.service').maybeUploadCampaignGoogleConversion;
    const health = async (campaignId = '200') => require('../../../services/campaignWorkspaceGoogleSignalEvidence.service').loadGoogleSignalEvidence({
      models, campaigns: [{ id: 'fictitious-campaign', provider: 'google_ads', assigned: true, clinicId: 71,
        account_id: mapping.customerId, campaign_id: campaignId }],
      selectedClinics: [await models.Clinica.findByPk(71, { raw: true })], now: now() });
    const firstWeb = web(), beforeWeb = writes();
    const uploaded = await uploadWeb(firstWeb);
    assert.equal(uploaded.sent, true); assert.equal(writes(), beforeWeb + 1);
    const attempt = await models.GoogleAdsConversionUploadAttempt.findByPk(uploaded.audit_id);
    assert.equal(attempt.connectionSource, 'workspace_mandate');
    assert.equal(attempt.requestMetadata.workspace_delivery.schema_version, 2);
    assert.equal((await uploadWeb(firstWeb)).reason, 'duplicate_already_accepted'); assert.equal(writes(), beforeWeb + 1);
    assert.equal((await health()).get('fictitious-campaign').processing, 1);
    report.checks.push('full workspace web mandate resolution reaches the common SQL coordinator and signed broker without tokens, preserves health binding and deduplicates repeated delivery');

    const beforePause = writes(), beforeAttempts = await models.GoogleAdsConversionUploadAttempt.count();
    const current = await getSetting(); await current.update({ activation: { ...activation, status: 'paused' }, version: current.version + 1 });
    assert.equal((await uploadWeb(web())).reason, 'workspace_activation_inactive');
    assert.equal(writes(), beforePause); assert.equal(await models.GoogleAdsConversionUploadAttempt.count(), beforeAttempts);
    await current.update({ activation, version: current.version + 1 });
    report.checks.push('a paused SQL workspace mandate stops the managed web flow before creating an attempt or calling the provider');

    await models.ExternalCampaignAssignment.create({ provider: 'google_ads', customer_id: mapping.customerId,
      campaign_id: '200', status: 'active', clinica_id: 71 });
    const nativeId = 'fictitious-native-id';
    await models.LeadIntake.create({ id: 19, clinica_id: 71, grupo_clinica_id: 5, source: 'google_ads', source_detail: 'leadgen_form:300',
      external_source: 'google_lead_form', external_id: createHash('sha256').update(nativeId).digest('hex'),
      google_ads_customer_id: mapping.customerId, google_ads_campaign_id: '200', status_lead: 'cualificado',
      consentimiento_canal: { ad_user_data: 'granted', ad_personalization: 'denied' }, gclid: 'FICTITIOUS-NATIVE-CLICK',
      email: 'fictitious@example.invalid', telefono: '34600000000' });
    await models.LeadAttributionAudit.create({ lead_intake_id: 19, raw_payload: { lead_id: nativeId }, attribution_steps: {
      advertising_identity: { version: 1, verified_by: 'google_ads_api', provider: 'google_ads', clinic_id: 71,
        account_id: mapping.customerId, campaign_id: '200', form_id: '300' } } });
    const native = require('../../../services/campaignWorkspaceGoogleNative.service').maybeUploadNativeGoogleLifecycleConversion;
    const input = { leadId: 19, clinicId: 71, eventName: 'qualified_lead', eventId: 'lead-19-qualified', occurredAt: now().toISOString(),
      crmEventSource: require('../../../services/campaignWorkspaceSignalPolicy.service').CRM_MILESTONE_SOURCE };
    const beforeNative = writes(), nativeResult = await native(input, dependencies);
    assert.equal(nativeResult.sent, true); assert.equal(writes(), beforeNative + 1);
    const nativeAttempt = await models.GoogleAdsConversionUploadAttempt.findByPk(nativeResult.audit_id);
    assert.equal(nativeAttempt.connectionSource, 'workspace_native_mandate'); assert.equal(nativeAttempt.intakeConfigId, null);
    assert.equal(nativeAttempt.requestMetadata.consent_source, 'google_ads_native_crm');
    assert.equal(nativeAttempt.requestMetadata.workspace_delivery.schema_version, 3);
    assert.equal((await native(input, dependencies)).reason, 'duplicate_already_accepted'); assert.equal(writes(), beforeNative + 1);
    report.checks.push('native CRM milestone verifies persisted attribution, mandate, recipient and consent in SQL and uses OTHER through the broker without requiring a website or replaying the milestone');

    const appointment = { ...input, eventName: 'schedule', eventId: 'appointment-39' };
    assert.equal((await native(appointment, dependencies)).reason, 'workspace_google_native_milestone_not_current');
    await models.CitaPaciente.create({ id_cita: 39, lead_intake_id: 19, clinica_id: 59, estado: 'pendiente', es_provisional: false });
    assert.equal((await native(appointment, dependencies)).reason, 'workspace_google_native_milestone_not_current');
    await models.CitaPaciente.update({ clinica_id: 71 }, { where: { id_cita: 39 } });
    assert.equal((await native(appointment, dependencies)).sent, true);
    report.checks.push('native scheduling requires a current appointment for the same lead and clinic; a sibling clinic appointment cannot authorize delivery');

    const readLead = models.LeadIntake.findByPk, healthWrites = writes(), healthValidations = validations.length, healthCalls = calls();
    models.LeadIntake.findByPk = () => assert.fail('Health must not read personal lead contacts');
    try {
      const summary = (await health()).get('fictitious-campaign');
      assert.equal(summary.checked, true); assert.equal(summary.processing, 2); assert.equal(summary.processed, 0);
    } finally { models.LeadIntake.findByPk = readLead; }
    assert.equal(writes(), healthWrites); assert.equal(validations.length, healthValidations); assert.equal(calls(), healthCalls);
    report.checks.push('actual Health resolves managed web and native delivery records without tokens or contact reads, distinguishes acceptance from processing and discards old mandate evidence');

    await require('./google_conversion_diagnostics_checks.fixture')({ models, report, now, writes, calls,
      setAfterRemote, setBeforeRemote, setProviderMode, web, uploadWeb, getSetting, health,
      nativeAttemptId: nativeResult.audit_id });

    const oldSetting = (await getSetting()).get({ plain: true }), oldConfig = structuredClone(cfg.config);
    const assignment = await models.GoogleConnectionAssignment.findByPk(100), oldConnectedAt = assignment.connectedAt;
    try {
      await (await getSetting()).update({ activation: { schema_version: 1, status: 'active', mode: 'measurement',
        signals: { enabled: true, events: ['lead'] }, account_authorizations: accounts }, version: oldSetting.version + 1 });
      await cfg.update({ config: { ...oldConfig, campaigns: { workspace_policy: {
        schema_version: 1, setting_id: setting.id, scope_type: 'clinic', scope_id: 71 } } } });
      await assignment.update({ connectedAt: new Date(+now() - 3600000) });
      const options = web(); options.customData.campaign_id = '201';
      const v1 = await require('../../../services/googleAdsConversionUpload.service').maybeUploadGoogleConversion({
        ...options, groupId: 5, assignmentScope: 'clinic', dependencies: { ...dependencies,
          auditModel: models.GoogleAdsConversionUploadAttempt,
          resolveRuntime: input => require('../../../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime({ ...input, broker }) } });
      assert.equal(v1.sent, true);
      const attempt = await models.GoogleAdsConversionUploadAttempt.findByPk(v1.audit_id);
      assert.equal(attempt.requestMetadata.workspace_delivery.schema_version, 1);
      const callsBefore = calls();
      const evidence = (await health('201')).get('fictitious-campaign');
      assert.equal(evidence.checked, true); assert.equal(evidence.processing, 1); assert.equal(evidence.processed, 0);
      assert.equal(calls(), callsBefore);
      report.checks.push('schema-v1 workspace emitter and actual Health share the managed scoped runtime and metadata-only final permission checks without contacting the broker from the report');
      const beforeStatus = writes();
      const receipt = await require('../../../services/googleConversionDiagnosticsBroker.service').reconcileManagedGoogleConversion({ models, attemptId: v1.audit_id, now });
      assert.equal(receipt.state, 'succeeded'); assert.equal(writes(), beforeStatus);
      assert.equal((await health('201')).get('fictitious-campaign').processed, 1);
      report.checks.push('schema-v1 diagnostics revalidate current installation and mandate, reconcile through the signed broker and update Health without another ingestion');
      await cfg.update({ config: oldConfig });
      await (await getSetting()).update({ activation: null, version: oldSetting.version + 2 });
      const direct = await require('../../../services/googleAdsConversionUpload.service').maybeUploadGoogleConversion({
        ...web(), groupId: 5, assignmentScope: 'clinic', dependencies: { ...dependencies,
          auditModel: models.GoogleAdsConversionUploadAttempt,
          resolveRuntime: input => require('../../../services/googleAdsScopedRuntime.service').resolveScopedGoogleAdsRuntime({ ...input, broker }) } });
      assert.equal(direct.sent, true);
      assert.equal((await models.GoogleAdsConversionUploadAttempt.findByPk(direct.audit_id)).requestMetadata.workspace_delivery, undefined);
      const directCalls = calls(), directWrites = writes();
      await cfg.update({ config: { ...oldConfig, google_ads: { ...oldConfig.google_ads, enabled: false } } });
      await assert.rejects(require('../../../services/googleConversionDiagnosticsBroker.service').reconcileManagedGoogleConversion({ models, attemptId: direct.audit_id, now }), { code: 'conversion_paused' });
      assert.equal(calls(), directCalls);
      await cfg.update({ config: oldConfig });
      assert.equal((await require('../../../services/googleConversionDiagnosticsBroker.service').reconcileManagedGoogleConversion({ models, attemptId: direct.audit_id, now })).state, 'succeeded');
      assert.equal(writes(), directWrites);
      report.checks.push('configured direct conversions without a workspace mandate recover by owned receipt, while disabling current tracking stops status access before transport');
    } finally {
      await cfg.update({ config: oldConfig });
      await (await getSetting()).update({ activation: oldSetting.activation, version: oldSetting.version });
      await assignment.update({ connectedAt: oldConnectedAt });
    }

    const afterWrites = writes(); await models.GoogleConnectionAssignment.update({ status: 'disconnected' }, { where: { id: 100 } });
    await assert.rejects(grant.assertGoogleAdsGrantTransport(context.brokerGrant), { code: 'scope_denied' });
    await assert.rejects(preparation.googlePreparationContext({ models, scope, accountId: mapping.customerId }), { code: 'workspace_google_permissions_required' });
    assert.equal(writes(), afterWrites);
    await models.GoogleConnectionAssignment.update({ status: 'active' }, { where: { id: 100 } });
    report.checks.push('revoking the real SQL group assignment invalidates old broker grants and fresh workspace resolution without any legacy credential fallback');

    const lost = web(); setAfterRemote(async command => {
      if (command.operation === 'google.ads.conversion.ingest.v1') { setAfterRemote(null);
        const current = await getSetting(); await current.update({ activation: { ...activation, status: 'paused' }, version: current.version + 1 }); }
    });
    await assert.rejects(uploadWeb(lost), { code: 'conversion_paused' });
    const unknown = await models.GoogleAdsConversionUploadAttempt.findOne({ where: { eventId: lost.eventId } });
    assert.equal(unknown.reason, 'broker_outcome_unknown');
    const lostWrites = writes(); assert.equal((await uploadWeb(lost)).sent, false); assert.equal(writes(), lostWrites);
    const resumed = await getSetting(); await resumed.update({ activation, version: resumed.version + 1 });
    report.checks.push('pausing a mandate after provider acceptance leaves durable uncertainty and cannot cause legacy fallback or a second ingestion');

    setAfterRemote(async command => {
      if (command.operation === 'google.ads.conversion.validate.v1') { setAfterRemote(null);
        const current = await getSetting(); await current.update({ preferences: { mode: 'measurement', signals: { enabled: false, events } }, version: current.version + 1 }); }
    });
    await assert.rejects(prepare(), { code: 'workspace_signal_preferences_required' });
    assert.equal(writes(), lostWrites);
    assert.equal((await getSetting()).signal_preparation.google_ads[mapping.customerId].status, 'checking');
    report.checks.push('a concurrent change during validate-only prevents publication of a successful preparation proof and never ingests an event');
  } finally { B.forModels = previous; setAfterRemote(null); }
};
