'use strict';
// Owned mysqld/socket + real signed broker/SQLite + provider double. No host
// database, Meta, Redis, email or WhatsApp connection is permitted by the fixture.
const assert = require('node:assert/strict');
const { DataTypes: D, Op, Sequelize } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createMetaMarketingLeadReader, cooldownWait } = require('../../services/metaMarketingLeadReader.service');
const { createMetaLeadWebhookHandlers } = require('../../services/metaLeadWebhook.service');
const reception = require('../../services/metaLeadReception.service');
const { loadRoute } = require('../../services/metaLeadRoutes.service');
const { attachLeadAdvertisingIdentities } = require('../../services/leadAdvertisingIdentity.service');
const ownerFixture = require('../../../services/integrations-broker/test/meta-marketing-leads-fixture.cjs');
const L = require('../../../services/integrations-broker/src/meta-marketing-leads-contract');
process.env.JOB_RUNTIME_NAMESPACE = 'meta-lead-native-qa';
process.env.RUNTIME_ROLE = 'api';
process.env.JOBS_AUTO_START = 'false';
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const cleanup = [];
  try {
    const owner = await ownerFixture.ready({ after: fn => cleanup.push(fn) }, { recipientClinicId: 71 });
    const define = (name, fields, options = {}) => sql.define(name, fields, { timestamps: false, ...options });
    models.Sequelize = Sequelize;
    models.Clinica = define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER, estado_clinica: D.BOOLEAN });
    models.ClinicMetaAsset = define('ClinicMetaAsset', { id: { type: D.INTEGER, primaryKey: true }, assetType: D.STRING,
      metaAssetId: D.STRING, metaConnectionId: D.INTEGER, assignmentScope: D.STRING, clinicaId: D.INTEGER, grupoClinicaId: D.INTEGER, isActive: D.BOOLEAN });
    models.MetaMarketingBrokerBinding = define('MetaMarketingBrokerBinding', { mapping_id: { type: D.INTEGER, primaryKey: true },
      enrollment_id: D.STRING, scope_key: D.STRING, connection_ref: D.STRING, asset_ref: D.STRING, app_id: D.STRING, state: D.STRING });
    models.CampaignWorkspaceSetting = define('CampaignWorkspaceSetting', { id: { type: D.STRING, primaryKey: true }, scope_type: D.STRING,
      scope_id: D.INTEGER, version: D.INTEGER, accounts: D.JSON, preferences: D.JSON });
    models.ExternalCampaignAssignment = define('ExternalCampaignAssignment', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
      provider: D.STRING, customer_id: D.STRING, campaign_id: D.STRING, clinica_id: D.INTEGER, status: D.STRING });
    models.LeadIntake = define('LeadIntake', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
      clinica_id: D.INTEGER, grupo_clinica_id: D.INTEGER, event_id: { type: D.STRING, unique: true }, external_source: D.STRING(64), external_id: D.STRING(128),
      source: D.STRING, channel: D.STRING, source_detail: D.STRING, utm_source: D.STRING, utm_medium: D.STRING,
      clinic_match_source: D.STRING, clinic_match_value: D.STRING, status_lead: D.STRING, nombre: D.STRING, email: D.STRING,
      telefono: D.STRING, email_hash: D.STRING, phone_hash: D.STRING, archived_at: D.DATE, created_at: { type: D.DATE, defaultValue: D.NOW } },
    { indexes: [{ unique: true, fields: ['external_source', 'external_id'] }] });
    models.LeadAttributionAudit = define('LeadAttributionAudit', { id: { type: D.INTEGER, autoIncrement: true, primaryKey: true },
      lead_intake_id: D.INTEGER, raw_payload: D.JSON, attribution_steps: D.JSON, created_at: { type: D.DATE, defaultValue: D.NOW } });
    models.FormSubmissionEvent = require('../../../models/formsubmissionevent')(sql, D);
    models.JobRequest = require('../../../models/jobrequest')(sql, D);
    await sql.sync();
    await models.Clinica.bulkCreate([71, 72].map(id => ({ id_clinica: id, grupoClinicaId: 9, estado_clinica: true })));
    await models.ClinicMetaAsset.bulkCreate([{ id: 10, assetType: 'facebook_page', metaAssetId: '401', metaConnectionId: 1,
      assignmentScope: 'group', clinicaId: null, grupoClinicaId: 9, isActive: true }, { id: 11, assetType: 'ad_account', metaAssetId: 'act_301',
      metaConnectionId: 1, assignmentScope: 'group', clinicaId: null, grupoClinicaId: 9, isActive: true }]);
    await models.MetaMarketingBrokerBinding.bulkCreate([{ mapping_id: 10, asset_ref: ownerFixture.PAGE }, { mapping_id: 11, asset_ref: ownerFixture.ACCOUNT }]
      .map(row => ({ ...row, enrollment_id: owner.id, scope_key: 'group:9', connection_ref: owner.f.binding.connectionRef, app_id: '101', state: 'active' })));
    const explicit = { pageAssetRef: ownerFixture.PAGE, adAccountAssetRef: ownerFixture.ACCOUNT, recipientClinicId: 71 };
    await models.CampaignWorkspaceSetting.create({ id: 'native-lead-setting', scope_type: 'group', scope_id: 9, version: 1,
      accounts: [{ provider: 'meta_ads', account_id: '301', include_future: true, campaign_ids: [] }], preferences: { meta_lead_routes: [explicit] } });
    const metadata = async (mappingId, transaction = null) => {
      const options = { raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) };
      const row = await models.MetaMarketingBrokerBinding.findByPk(mappingId, options);
      if (!row || row.state !== 'active') throw Object.assign(Error('asset_revoked'), { code: 'asset_revoked' });
      return { mappingId, kind: mappingId === 10 ? 'facebook_page' : 'ad_account', id: mappingId === 10 ? '401' : '301',
        assetRef: row.asset_ref, connectionId: 1, connectionRef: row.connection_ref, appId: '101', subjectId: '201', enrollmentHash: owner.id,
        tenantRef: 'clinic:71', scopeKey: 'group:9', clinicIds: [71, 72] };
    };
    const contexts = new WeakMap(), state = { routeAfterRead: false, notify: new Set(), sends: 0, brokerCalls: 0, receiptCommandIds: [] };
    const scope = { prepare: async id => { const context = {}; contexts.set(context, id); return context; }, assertContext: context => metadata(contexts.get(context)) };
    const reader = createMetaMarketingLeadReader({ scope, enabled: () => true, now: owner.f.now,
      loadRoute: (page, account, transaction) => loadRoute({ models, page, account, transaction }),
      transactionStates: async (pageId, accountId, transaction) => ({ page: pageId === null ? null : await metadata(pageId, transaction), account: await metadata(accountId, transaction) }),
      client: { execute: async command => {
        state.brokerCalls++;
        if (L.family(command.operation) === 'receiptRead') state.receiptCommandIds.push(command.requestId);
        const result = await owner.execute(L.family(command.operation), command.payload, { requestId: command.requestId,
          connectionRef: command.connectionRef, assetRef: command.assetRef, tenantRef: command.tenantRef });
        if (state.routeAfterRead && L.family(command.operation) === 'receiptRead') {
          state.routeAfterRead = false;
          await models.CampaignWorkspaceSetting.update({ version: 2, preferences: { meta_lead_routes: [{ ...explicit, recipientClinicId: 72 }] } }, { where: { id: 'native-lead-setting' } });
        }
        return result;
      } } });
    const jobs = require('../../services/jobRequests.service');
    const handler = createMetaLeadWebhookHandlers({ models, reader, env: { JOB_RUNTIME_NAMESPACE: 'meta-lead-native-qa', META_APP_ID: '101' },
      enqueue: input => jobs.enqueueUniqueJobRequest(input) });
    const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
      status(code) { this.statusCode = code; return this; }, type() { return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } });
    const raw = ownerFixture.rawEvent(), accepted = ownerFixture.acceptPayload(raw);
    const request = { rawBody: raw, rawHeaders: ['content-type', 'application/json', 'x-hub-signature-256', accepted.signature],
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': accepted.signature } };
    const bad = response(); await handler.receive({ ...request, headers: { ...request.headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } }, bad);
    assert.equal(bad.statusCode, 401); assert.equal(await models.JobRequest.count(), 0);
    report.checks.push('Bad raw-body HMAC creates neither owner receipt nor CRM job');
    const beforeCalls = owner.state.calls.length, replies = [response(), response()];
    await Promise.all(replies.map(reply => handler.receive(request, reply)));
    assert(replies.every(reply => reply.statusCode === 200)); assert.equal(await models.JobRequest.count(), 1);
    assert.equal(owner.state.calls.length, beforeCalls, 'webhook receipt must not query Graph');
    const job = await models.JobRequest.findOne({ raw: true });
    assert.equal(job.payload.__runtime_namespace, 'meta-lead-native-qa');
    assert.equal(job.max_attempts, 8); assert(!JSON.stringify(job.payload).includes('qa@example.invalid'));
    report.checks.push('Signed concurrent redelivery commits one stable owner receipt and one namespace-scoped native JobRequest');
    const notify = async ({ lead }) => { state.notify.add(Number(lead.id)); };
    const first = await reception.runMetaLeadReceptionJob(job.payload, job, { models, reader, notify });
    assert.equal(first.status, 'completed'); assert.equal(await models.LeadIntake.count(), 1); assert.equal(await models.LeadAttributionAudit.count(), 1);
    assert.equal(state.sends, 0); assert.equal(state.notify.size, 1);
    report.checks.push('Paid shared-account lead routes to the explicitly configured page clinic without inferring a representative or duplicating account mappings');
    const duplicates = await Promise.all([1, 2].map(() => reception.runMetaLeadReceptionJob(job.payload, job, { models, reader, notify })));
    assert(duplicates.every(result => result.status === 'completed' && result.duplicate));
    assert.equal(await models.LeadIntake.count(), 1); assert.equal(await models.LeadAttributionAudit.count(), 1); assert.equal(state.notify.size, 1);
    const lead = await models.LeadIntake.findOne({ raw: true }), audit = await models.LeadAttributionAudit.findOne({ raw: true });
    assert.equal(lead.clinica_id, 71); assert.equal(lead.email, 'qa@example.invalid');
    assert(!JSON.stringify(audit).includes('NEVER_RETURN')); assert(!JSON.stringify(audit).includes('qa@example.invalid'));
    const attached = await attachLeadAdvertisingIdentities({ models, leads: [lead] });
    assert.equal(attached[0].advertising_identity.campaign_id, '601');
    report.checks.push('Concurrent duplicate execution preserves one lead/audit; reporting reads verified advertising identity and never custom medical answers');
    await models.ExternalCampaignAssignment.create({ provider: 'meta_ads', customer_id: '301', campaign_id: '601', clinica_id: 72, status: 'active' });
    const conflict = await reception.runMetaLeadReceptionJob(job.payload, job, { models, reader, notify });
    assert.equal(conflict.error_message, 'meta_lead_clinic_scope_mismatch'); assert.equal(await models.LeadIntake.count(), 1);
    await models.ExternalCampaignAssignment.destroy({ where: {} });
    report.checks.push('A campaign assignment conflicting with the explicit Page route is rejected rather than overriding user attribution');
    state.routeAfterRead = true;
    const changed = await reception.runMetaLeadReceptionJob(job.payload, job, { models, reader, notify });
    assert.equal(changed.status, 'failed'); assert.equal(await models.LeadIntake.count(), 1);
    await models.CampaignWorkspaceSetting.update({ version: 1, preferences: { meta_lead_routes: [explicit] } }, { where: { id: 'native-lead-setting' } });
    report.checks.push('Changing the versioned Page route during owner retrieval prevents returning or persisting that response');
    await models.MetaMarketingBrokerBinding.update({ state: 'blocked' }, { where: { mapping_id: 11 } });
    const calls = state.brokerCalls;
    const revoked = await reception.runMetaLeadReceptionJob(job.payload, job, { models, reader, notify });
    assert.equal(revoked.status, 'failed'); assert.equal(state.brokerCalls, calls); assert.equal(await models.LeadIntake.count(), 1);
    await models.MetaMarketingBrokerBinding.update({ state: 'active' }, { where: { mapping_id: 11 } });
    report.checks.push('Account revocation blocks the paired receipt before provider access');
    owner.pacingState.save('meta-ads-app:101', { next_allowed_at: owner.f.now() + 7200000, pause_until: owner.f.now() + 7200000 });
    const paused = await reception.runMetaLeadReceptionJob(job.payload, job, { models, reader, notify });
    assert.equal(paused.status, 'waiting'); assert.equal(paused.reason, 'meta_broker_cooldown');
    assert(+paused.nextAllowedAt > owner.f.now()); assert.equal(await models.LeadIntake.count(), 1);
    report.checks.push('Real durable owner cooldown becomes WAIT at the validated next time with zero automatic retries or external sends');
    const receipts = owner.current.store.db.prepare('SELECT COUNT(*) AS count FROM meta_marketing_lead_receipts').get();
    assert.equal(receipts.count, 1);
    const persisted = state.receiptCommandIds.map(id => owner.current.store.db.prepare('SELECT result FROM commands WHERE id=?').get(id)).filter(Boolean);
    assert(persisted.every(row => row.result === null));
    assert.equal(state.sends, 0); report.externalSends = 0;
    report.checks.push('Broker command persistence excludes returned contact data; receipt store retains identifiers only');
  } finally { for (const close of cleanup.reverse()) await close(); }
}).catch(error => { console.error(error.code || error.name, error.message); process.exitCode = 1; });
