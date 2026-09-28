'use strict';

// Real HTTP controllers/services and MySQL persistence. Authentication, provider
// observations are fixtures. Web receipts use the real signed intake handler,
// never a substitute for DEV login, installed-plugin or provider QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, createHmac } = require('node:crypto');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({ sql, models, report, registerOwnedLoopbackServer }) => {
  models.Sequelize = require('sequelize');
  const modelDirectory = path.resolve(__dirname, '../../../models');
  for (const file of fs.readdirSync(modelDirectory).filter(file => file.endsWith('.js') && file !== 'index.js')) {
    const define = require(path.join(modelDirectory, file));
    if (typeof define === 'function') { const model = define(sql, DataTypes); models[model.name] = model; }
  }
  models.FormSubmissionEvent.associate(models);
  models.LeadAttributionAudit.associate(models);
  models.FlowExecutionV2.associate(models);
  models.GrupoClinica.hasMany(models.Clinica, { foreignKey: 'grupoClinicaId', as: 'clinicas' });
  const tables = ['GrupoClinica', 'Clinica', 'UsuarioClinica', 'ClinicGoogleAdsAccount', 'ClinicMetaAsset',
    'ExternalCampaignInventory', 'ExternalCampaignAssignment', 'GoogleAdsAdInventory', 'GoogleAdsAdInsightsDaily',
    'GoogleAdsAdSyncDay', 'GoogleAdsInsightsDaily', 'CampaignWorkspaceSetting', 'CampaignWorkspaceEvent',
    'IntakeConfig', 'CampaignRequest', 'CampaignOptimizationPolicy', 'CampaignWorkspaceOptimizationRun',
    'LeadIntake', 'LeadAttributionAudit', 'FormSubmissionEvent', 'EconomicBudget', 'CitaPaciente',
    'GoogleAdsConversionUploadAttempt', 'JobRequest', 'WebPublication', 'WebArtifact', 'WebIntakeRuntimeReconciliation',
    'AutomationFlowTemplateV2', 'FlowExecutionV2'];
  await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  for (const name of tables) {
    const model = models[name]; assert.ok(model, name);
    for (const attr of Object.values(model.rawAttributes)) delete attr.references;
    // sync supplies fixture tables, not the migration chain's explicit index names.
    model._indexes = model._indexes.map((index, i) => index.name?.length > 64
      ? { ...index, name: `qa_${name}_${i}` } : index);
    model.refreshAttributes(); await model.sync();
  }
  const clinic = 59, group = 5, actor = 91002, account = '1234567890';
  await sql.query('ALTER TABLE ClinicGoogleAdsAccounts MODIFY COLUMN clinicaId INT NOT NULL');
  const groupRepair = require('../../../migrations/20260928180000-repair-google-ads-group-account-nullability');
  await groupRepair.up(sql.getQueryInterface());
  await groupRepair.up(sql.getQueryInterface());
  report.checks.push('group account nullability repair succeeds on real MySQL and is idempotent');
  const domain = 'campaign-lifecycle.example.invalid', url = `https://${domain}/landing`;
  await models.GrupoClinica.create({ id_grupo: group, nombre_grupo: 'Grupo ficticio QA' });
  await models.Clinica.bulkCreate([
    { id_clinica: clinic, grupoClinicaId: group, nombre_clinica: 'Clinica ficticia QA', estado_clinica: true },
    { id_clinica: 71, grupoClinicaId: group, nombre_clinica: 'Clinica sin acceso QA', estado_clinica: true },
  ]);
  await models.UsuarioClinica.create({ id_usuario: actor, id_clinica: clinic, rol_clinica: 'agencia', estado_invitacion: 'aceptada' });
  Object.assign(process.env, { INTAKE_VERIFICATION_ATTESTATION_SECRET: randomBytes(32).toString('hex'),
    CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true', CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'false',
    CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED: 'false', JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false',
    JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'backend', JOB_RUNTIME_NAMESPACE: 'qa-workspace-lifecycle' });
  const { createWorkspaceConfigurationHandlers, createWorkspaceHandler } = require('../../controllers/campaignWorkspace.controller');
  const { hasMarketingClinicScopeAccess, getAccessibleMarketingClinicIds } = require('../../lib/marketingScopeAccess');
  const { buildVerificationConfigHash, issueVerificationAttestation } = require('../../lib/intake-verification-attestation');
  const accessOptions = { membershipModel: models.UsuarioClinica, globalAdminCheck: () => false };
  const hasAccess = input => hasMarketingClinicScopeAccess({ ...input, ...accessOptions });
  const handlers = createWorkspaceConfigurationHandlers({ models, hasAccess });
  const { ingestLead } = require('../../controllers/intake.controller');
  const { loadCampaignWorkspace } = require('../../services/campaignWorkspace.service');
  const express = require('express'), asyncHandler = require('express-async-handler'), jwt = require('jsonwebtoken');
  const secret = randomBytes(32), token = jwt.sign({ userId: actor }, secret, { expiresIn: 600 });
  const app = express(); app.use(express.json({ verify: (req, res, body) => { req.rawBody = body; } }));
  app.post('/api/intake/leads', ingestLead);
  app.use((req, res, next) => {
    try { req.userData = jwt.verify((req.headers.authorization || '').replace(/^Bearer /, ''), secret, { algorithms: ['HS256'] }); next(); }
    catch { res.status(401).json({ error: 'qa_authentication_required' }); }
  });
  const base = '/api/marketing/campaign-workspace';
  app.get(base, asyncHandler(createWorkspaceHandler({ models, hasAccess,
    // Reports exclude today. Advance only the report clock, never the receipt or lead timestamps.
    load: options => loadCampaignWorkspace({ ...options, now: new Date(Date.now() + 86400000) }),
    accessibleClinics: input => getAccessibleMarketingClinicIds({ ...input, ...accessOptions }) })));
  for (const [method, suffix, handler] of [['get', '/configuration', 'get'], ['put', '/configuration', 'put'],
    ['get', '/preparation', 'preparation'], ['put', '/preferences', 'preferences'], ['put', '/activation', 'activate']]) {
    app[method](base + suffix, asyncHandler(handlers[handler]));
  }
  const unexpected = [];
  app.use((error, req, res, next) => { unexpected.push(error.message); res.status(500).json({ error: error.message }); });
  const server = http.createServer(app), agent = new http.Agent({ keepAlive: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); registerOwnedLoopbackServer(server);
  report.requests = 0;
  const request = (method, suffix, body, { scope = String(clinic), authenticated = true, intake = false, signingKey = null } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body); report.requests++;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method,
      path: intake ? '/api/intake/leads' : `${base}${suffix}?${new URLSearchParams({ scope })}`,
      headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        ...(signingKey ? { 'x-cc-signature': createHmac('sha256', signingKey).update(data).digest('hex') } : {}),
        ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); if (data !== null) req.write(data); req.end();
  });
  const ok = async promise => { const result = await promise; assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.headers['cache-control'], 'private, no-store'); return result.body; };
  const activation = preparation => ({ expected_version: preparation.configuration.version, preparation_revision: preparation.revision,
    mode: 'measurement', signals: { enabled: false }, confirmed: true });
  try {
    assert.equal((await request('GET', '/configuration', undefined, { authenticated: false })).status, 401);
    assert.equal((await request('GET', '/configuration', undefined, { scope: '71' })).status, 403);
    assert.equal((await request('GET', '/configuration', undefined, { scope: 'group:5' })).status, 403);
    const empty = await ok(request('GET', '/configuration'));
    assert.equal(empty.configuration.version, 0); assert.deepEqual(empty.accounts, []);
    assert.equal((await ok(request('GET', '/preparation'))).receptionReady, false);
    assert.equal(await models.CampaignWorkspaceSetting.count(), 0);
    report.checks.push('empty workspace reads do not create configuration; anonymous, foreign clinic and incomplete group access are refused');

    await models.ClinicGoogleAdsAccount.create({ clinicaId: clinic, assignmentScope: 'clinic', googleConnectionId: 2,
      customerId: account, descriptiveName: 'Cuenta ficticia QA', currencyCode: 'EUR', isActive: true });
    const campaign = await models.ExternalCampaignInventory.create({ provider: 'google_ads', customer_id: account, campaign_id: '200',
      campaign_name: 'Campana ficticia QA', status: 'ENABLED', last_seen_at: new Date() });
    const accounts = [{ provider: 'google_ads', account_id: account, include_future: true, campaign_ids: [] }];
    const saves = await Promise.all([1, 2].map(() => request('PUT', '/configuration', { expected_version: 0, accounts })));
    assert.deepEqual(saves.map(row => row.status).sort(), [200, 409]);
    assert.equal(saves.find(row => row.status === 409).body.error, 'workspace_version_conflict');
    assert.equal(await models.CampaignWorkspaceSetting.count(), 1); assert.equal(await models.CampaignWorkspaceEvent.count(), 1);
    assert.equal((await ok(request('PUT', '/configuration', { expected_version: 1, accounts }))).changed, false);
    assert.equal(await models.CampaignWorkspaceEvent.count(), 1);
    const config = await ok(request('GET', '/configuration'));
    assert.deepEqual(config.configuration.accounts, accounts); assert.equal(config.campaigns[0].clinicId, clinic);
    report.checks.push('concurrent first saves serialize to one setting/event and a 409; reload preserves selection; repeated save is idempotent');

    const preferences = { mode: 'measurement', signals: { enabled: false, events: [] }, optimization: null };
    await ok(request('PUT', '/preferences', { expected_version: 1, preferences }));
    assert.equal((await ok(request('PUT', '/preferences', { expected_version: 2, preferences }))).changed, false);
    assert.equal(await models.CampaignWorkspaceEvent.count(), 2);
    let preparation = await ok(request('GET', '/preparation'));
    assert.equal(preparation.campaigns[0].reason, 'destination_unverified');
    const record = { clinic_id: clinic, assignment_scope: 'clinic', domains: [domain], hmac_key: 'fictitious-snippet-only',
      config: { features: { consent_mode_enabled: true, consent_provider: 'clinicaclick', form_intercept_enabled: true },
        texts: { legal_url: '/legal', cookies_url: '/cookies', privacy_url: '/privacy' } } };
    const issued = issueVerificationAttestation({ scopeType: 'clinic', scopeId: clinic, domain,
      configHash: buildVerificationConfigHash({ scopeType: 'clinic', scopeId: clinic, domains: record.domains,
        config: record.config, hmacKey: record.hmac_key }),
      signals: { installed: true, runtime_compatible: true, runtime_version: '3.3.2', consent_mode_detected: true,
        google_consent_mode_detected: true, legal_urls_detected: true,
        legal_pages: Object.fromEntries(['legal', 'cookies', 'privacy'].map(key => [key, { configured: true, reachable: true }])) } });
    assert.ok(issued.token);
    record.config.snippet_verification = { attestations_by_domain: { [domain]: issued.token } };
    await models.IntakeConfig.create(record);
    await campaign.update({ destination_detection: { workspace_google: { version: 1, source: 'workspace_google_ads',
      status: 'checked', complete: true, checked_at: new Date().toISOString(), kind: 'web', urls: [url], forms: [] } } });
    preparation = await ok(request('GET', '/preparation'));
    assert.equal(preparation.receptionReady, false); assert.equal(preparation.campaigns[0].reason, 'web_reception_unverified');
    const premature = await request('PUT', '/activation', activation(preparation));
    assert.equal(premature.status, 409); assert.equal(premature.body.error, 'workspace_reception_pending');
    report.checks.push('a verified web configuration and destination do not fabricate receipt evidence or permit premature activation');

    await models.FormSubmissionEvent.create({ clinic_id: clinic, page_url: url, submitted_at: new Date(), form_id: 'orphan-fixture' });
    const foreignLead = await models.LeadIntake.create({ clinica_id: 71, source: 'web', nombre: 'Contacto ficticio ajeno' });
    await models.FormSubmissionEvent.create({ clinic_id: clinic, lead_intake_id: foreignLead.id,
      page_url: url, submitted_at: new Date(), form_id: 'foreign-fixture' });
    assert.equal((await ok(request('GET', '/preparation'))).receptionReady, false);
    report.checks.push('a form event without a CRM lead or linked to a foreign clinic cannot mark reception ready');

    const submission = { clinic_id: clinic, source: 'web', channel: 'paid', event_id: 'qa-lifecycle-form',
      google_ads_customer_id: account, google_ads_campaign_id: '200', page_url: url + '?gclid=fixture',
      consent: false, form_submission: { form_id: 'fixture-form', page_url: url + '?gclid=fixture',
        fields: { nombre: 'Contacto ficticio QA', email: 'qa@example.invalid' } } };
    const submit = (body = submission, signingKey = record.hmac_key) => request('POST', '', body,
      { intake: true, authenticated: false, signingKey });
    const beforeLeadCount = await models.LeadIntake.count(), beforeReceiptCount = await models.FormSubmissionEvent.count();
    assert.equal((await submit(submission, null)).status, 401);
    assert.equal((await submit(submission, 'wrong-fictitious-key')).status, 401);
    assert.equal((await submit({ ...submission, page_url: 'https://foreign.example.invalid/landing' })).status, 403);
    assert.equal(await models.LeadIntake.count(), beforeLeadCount);
    assert.equal(await models.FormSubmissionEvent.count(), beforeReceiptCount);
    assert.equal((await ok(request('GET', '/preparation'))).receptionReady, false);
    const accepted = await submit(); assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const lead = await models.LeadIntake.findByPk(accepted.body.id);
    assert.equal(lead.clinica_id, clinic); assert.equal(lead.email, 'qa@example.invalid');
    assert.equal(lead.google_ads_customer_id, account); assert.equal(lead.google_ads_campaign_id, '200');
    assert.equal(lead.campana_id, null);
    assert.equal(await models.LeadIntake.count(), beforeLeadCount + 1);
    assert.equal(await models.FormSubmissionEvent.count({ where: { lead_intake_id: lead.id, clinic_id: clinic } }), 1);
    assert.equal(await models.LeadAttributionAudit.count({ where: { lead_intake_id: lead.id } }), 1);
    const duplicate = await submit(); assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.id, lead.id); assert.equal(await models.LeadIntake.count(), beforeLeadCount + 1);
    assert.equal(await models.GoogleAdsConversionUploadAttempt.count(), 0);
    assert.equal(await models.JobRequest.count(), 0);
    report.checks.push('signed HTTP form creates CRM lead, audit and receipt without a local campaign; missing/wrong signatures and foreign domain write nothing; duplicate does not create another lead or advertising job');
    const stale = await request('PUT', '/activation', activation(preparation));
    assert.equal(stale.status, 409); assert.equal(stale.body.error, 'workspace_preparation_changed');
    preparation = await ok(request('GET', '/preparation')); assert.equal(preparation.receptionReady, true);
    assert.equal((await ok(request('GET', '/preparation'))).revision, preparation.revision);
    const active = await ok(request('PUT', '/activation', activation(preparation)));
    assert.equal(active.configuration.activation.mode, 'measurement'); assert.equal(active.configuration.activation.signals.enabled, false);
    assert.equal(active.configuration.version, 3);
    const restored = await ok(request('GET', '/preparation'));
    assert.equal(restored.existing.mode, 'connect_only'); assert.equal(restored.receptionReady, true);
    assert.equal((await models.IntakeConfig.findOne()).config.features.form_intercept_enabled, true);
    assert.deepEqual((await models.CampaignWorkspaceEvent.findAll({ order: [['version', 'ASC']] })).map(row => row.event_type),
      ['accounts_selected', 'preferences_saved', 'measurement_activated']);
    const summary = await ok(request('GET', ''));
    assert.equal(summary.report.rows.length, 1); assert.equal(summary.report.healthBlocks.length, 6);
    assert.equal(summary.report.current.leads, 1);
    assert.doesNotMatch(JSON.stringify(summary), /fictitious-snippet-only|Contacto ficticio QA|attestations_by_domain/);
    assert.equal(await models.JobRequest.count(), 0);
    report.checks.push('SQL receipt join changes the review revision; fresh review activates measurement without signals/jobs, preserves web settings and restores the real report with six health blocks');

    await models.ExternalCampaignInventory.create({ provider: 'google_ads', customer_id: account, campaign_id: '201',
      campaign_name: 'Nueva campana ficticia', status: 'ENABLED', last_seen_at: new Date() });
    const expanded = await ok(request('GET', '/preparation'));
    assert.equal(expanded.counts.total, 2); assert.equal(expanded.counts.ready, 1); assert.equal(expanded.receptionReady, false);
    await ok(request('PUT', '/configuration', { expected_version: 3,
      accounts: [{ ...accounts[0], include_future: false, campaign_ids: ['200'] }] }));
    const narrowed = await ok(request('GET', '/preparation'));
    assert.equal(narrowed.counts.total, 1); assert.equal(narrowed.receptionReady, true);
    const version = narrowed.configuration.version, eventsBefore = await models.CampaignWorkspaceEvent.count();
    models.CampaignWorkspaceEvent.addHook('beforeCreate', 'qa-audit-failure', () => { throw Error('fictitious_audit_failure'); });
    const rejected = await request('PUT', '/configuration', { expected_version: version, accounts: [] });
    models.CampaignWorkspaceEvent.removeHook('beforeCreate', 'qa-audit-failure');
    assert.equal(rejected.status, 500); assert.deepEqual(unexpected.splice(0), ['fictitious_audit_failure']);
    assert.equal((await models.CampaignWorkspaceSetting.findOne()).version, version);
    assert.equal(await models.CampaignWorkspaceEvent.count(), eventsBefore);
    assert.equal((await ok(request('GET', '/preparation'))).counts.total, 1);
    report.checks.push('future campaigns appear unprepared without extending receipt proof; explicit exclusion persists; failed audit rolls back selection and version');
    await models.GrupoClinica.create({ id_grupo: 6, nombre_grupo: 'Grupo agregado ficticio' });
    for (const id of [81, 82]) {
      await models.Clinica.create({ id_clinica: id, grupoClinicaId: 6, nombre_clinica: 'Sede ficticia ' + id, estado_clinica: true });
      await models.UsuarioClinica.create({ id_usuario: actor, id_clinica: id, rol_clinica: 'agencia', estado_invitacion: 'aceptada' });
    }
    const groupAccount = '9876543210';
    const shared = await models.ClinicGoogleAdsAccount.create({ clinicaId: null, grupoClinicaId: 6, assignmentScope: 'group',
      googleConnectionId: 2, customerId: groupAccount, descriptiveName: 'Cuenta compartida ficticia', currencyCode: 'EUR', isActive: true });
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    for (const [index, id] of [81, 82, null].entries()) {
      const campaignId = '300' + index;
      const inventory = await models.ExternalCampaignInventory.create({ provider: 'google_ads', customer_id: groupAccount,
        campaign_id: campaignId, campaign_name: id ? 'Visita compartida' : 'Pendiente sin sede', status: 'ENABLED', last_seen_at: new Date() });
      if (id) await models.ExternalCampaignAssignment.create({ inventory_id: inventory.id, provider: 'google_ads', customer_id: groupAccount,
        campaign_id: campaignId, grupo_clinica_id: 6, clinica_id: id, status: 'active' });
      await models.GoogleAdsInsightsDaily.create({ clinicGoogleAdsAccountId: shared.id, clinicaId: id, customerId: groupAccount,
        campaignId, date, costMicros: [40, 60, 20][index] * 1e6 });
      for (let n = 0; id && n < index + 2; n++) await models.LeadIntake.create({ clinica_id: id, source: 'google_ads',
        channel: 'paid', google_ads_customer_id: groupAccount, google_ads_campaign_id: campaignId, nombre: 'Contacto ficticio agregado' });
    }
    const groupResult = await ok(request('GET', '', undefined, { scope: 'group:6' }));
    assert.equal(groupResult.accounts.length, 1); assert.equal(groupResult.accounts[0].sharedOutsideScope, false);
    assert.equal(groupResult.report.rows.length, 3); assert.equal(groupResult.report.current.spend, 100); assert.equal(groupResult.report.current.leads, 5);
    const unassigned = groupResult.report.rows.find(row => !row.campaign.assigned);
    assert.equal(unassigned.current.spend, 20); assert.equal(unassigned.current.leads, null);
    assert.equal(groupResult.report.healthBlocks.length, 6);
    assert.equal(new Set(groupResult.report.rows.map(row => row.campaign.id)).size, 3);
    const north = await ok(request('GET', '', undefined, { scope: '81' }));
    assert.equal(north.report.rows.length, 1); assert.equal(north.report.rows[0].campaign.clinicId, 81);
    assert.equal(north.report.current.spend, 40); assert.equal(north.report.current.leads, 2);
    assert.equal(north.accounts[0].sharedOutsideScope, true);
    assert.doesNotMatch(JSON.stringify(north), /3001|3002|Pendiente sin sede|Contacto ficticio agregado/);
    const all = await ok(request('GET', '', undefined, { scope: 'all' }));
    assert.equal(all.report.rows.length, 4); assert.equal(all.report.current.leads, 6);
    assert.equal(all.report.current.spend, null, 'A clinic with missing investment keeps the aggregate unavailable');
    assert.equal((await request('GET', '/configuration', undefined, { scope: 'all' })).status, 400);
    report.checks.push('group, clinic and all HTTP reports use SQL assignments; shared campaigns count once, unassigned totals stay excluded and absent investment remains unknown');
    await models.UsuarioClinica.update({ estado_invitacion: 'pendiente' }, { where: { id_usuario: actor, id_clinica: 82 } });
    assert.equal((await request('GET', '', undefined, { scope: 'group:6' })).status, 403);
    assert.equal((await request('GET', '', undefined, { scope: '81,82' })).status, 403);
    const reduced = await ok(request('GET', '', undefined, { scope: 'all' }));
    assert.equal(reduced.report.rows.length, 2); assert.equal(reduced.report.current.leads, 3);
    assert.doesNotMatch(JSON.stringify(reduced), /3001|3002|Pendiente sin sede/);
    assert.equal(await models.CampaignWorkspaceEvent.count(), eventsBefore);
    report.checks.push('revoking one group member immediately removes its campaigns from all, refuses explicit group/CSV and leaves configuration audits unchanged');
    await models.UsuarioClinica.update({ estado_invitacion: 'pendiente' }, { where: { id_usuario: actor } });
    assert.equal((await request('GET', '/configuration')).status, 403);
    assert.equal((await request('PUT', '/configuration', { expected_version: version, accounts: [] })).status, 403);
    assert.equal(await models.CampaignWorkspaceEvent.count(), eventsBefore);
    assert.equal(await models.JobRequest.count(), 0); assert.deepEqual(unexpected, []);
    report.checks.push('revoked membership refuses subsequent reads/writes; no business job or provider request is needed for this lifecycle');
  } finally {
    agent.destroy(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
