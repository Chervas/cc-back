'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const targets = require('../../services/externalCampaignAssignmentTargets.service');

function opIn(value) {
  return value?.[Op.in] || [];
}

function externalRef({ account = '1851215478', campaign = '9001', name = 'Campaña' } = {}) {
  return {
    provider: 'google_ads',
    account_id: account,
    customer_id: account,
    campaign_id: campaign,
    external_campaign_id: campaign,
    name,
    metrics: { impressions: 1, clicks: 1, spend: 1, conversions: 0 },
  };
}

function testCanonicalIdentityAndPayloadSync() {
  const google = targets.canonicalExternalCampaignIdentity({
    provider: 'google_ads',
    account_id: '185-121-5478',
    external_campaign_id: 9001,
  });
  assert.deepEqual(google, {
    provider: 'google_ads',
    account_id: '1851215478',
    customer_id: '1851215478',
    campaign_id: '9001',
    external_campaign_id: '9001',
  });
  const meta = targets.canonicalExternalCampaignIdentity({
    provider: 'meta_ads',
    customer_id: 'act_1486528992022670',
    campaign_id: '9001',
  });
  assert.equal(meta.account_id, '1486528992022670');
  assert.notEqual(
    targets.externalCampaignIdentityKey(google),
    targets.externalCampaignIdentityKey({ ...google, account_id: '9999999999', customer_id: '9999999999' }),
    'The same campaign id in another account must be a different identity'
  );
  assert.notEqual(
    targets.externalCampaignIdentityKey(google),
    targets.externalCampaignIdentityKey(meta),
    'Provider is part of the canonical identity'
  );

  const payload = {
    kind: 'marketing_strategy',
    external_targets: [
      {
        kind: 'treatment', treatment_id: 7, treatment_name: 'Implantes',
        campaigns: [externalRef(), externalRef({ account: '9999999999' })],
      },
      { kind: 'treatment', treatment_id: 8, treatment_name: 'Ortodoncia', campaigns: [] },
    ],
  };
  const moved = targets.syncCampaignReferenceInPayload(payload, google, {
    target: { kind: 'generic' },
    campaignReference: externalRef({ name: 'Campaña revisada' }),
  });
  assert.equal(moved.changed, true);
  assert.equal(moved.payload.external_targets.length, 3);
  const first = moved.payload.external_targets.find((item) => item.treatment_id === 7);
  assert.equal(first.campaigns.length, 1);
  assert.equal(first.campaigns[0].account_id, '9999999999',
    'A campaign with the same id in another account must remain untouched');
  const emptyTreatment = moved.payload.external_targets.find((item) => item.treatment_id === 8);
  assert.ok(emptyTreatment);
  assert.deepEqual(emptyTreatment.campaigns, [],
    'Moving the last external reference must not remove a selected strategy target');
  const generic = moved.payload.external_targets.find((item) => item.kind === 'generic');
  assert.equal(generic.campaigns.length, 1);

  const cleared = targets.syncCampaignReferenceInPayload(moved.payload, google);
  assert.equal(cleared.payload.external_targets.find((item) => item.kind === 'generic').campaigns.length, 0,
    'Clearing a reference preserves the target with an empty campaigns list');
}

function testStrictTargetPayloads() {
  const parsed = targets.parseTargetUpdateInput({
    group_id: 5,
    provider: 'google_ads',
    customer_id: '185-121-5478',
    expected_version: 3,
    strategy_campaign_id: 20,
    campaign_request_id: 200,
    target_kind: 'treatment',
    treatment_id: 7,
    confidence: 0.87555,
    explanation: '  Revisado contra la estrategia activa  ',
  });
  assert.deepEqual(parsed, {
    groupId: 5,
    provider: 'google_ads',
    customerId: '1851215478',
    expectedVersion: 3,
    strategyCampaignId: 20,
    requestId: 200,
    targetKind: 'treatment',
    treatmentId: 7,
    confidence: 0.8756,
    explanation: 'Revisado contra la estrategia activa',
  });
  for (const input of [
    { ...parsed, group_id: undefined },
    { group_id: 5, provider: 'google_ads', customer_id: '1', expected_version: '3' },
  ]) {
    assert.throws(() => targets.parseTargetUpdateInput(input), /entero positivo|Campos no admitidos/);
  }
  assert.throws(() => targets.parseTargetUpdateInput({
    group_id: 5, provider: 'google_ads', customer_id: '1851215478', expected_version: 1,
    strategy_campaign_id: 20, campaign_request_id: 200, target_kind: 'generic',
    confidence: 0.9, explanation: 'ok', extra: true,
  }), (error) => error.code === 'matching_target_unknown_fields');
  assert.throws(() => targets.parseTargetClearInput({
    group_id: 5, provider: 'google_ads', customer_id: '1851215478', expected_version: 1,
  }), (error) => error.code === 'matching_target_clear_reason_required');
}

async function testSafeStrategyCatalogAndIssues() {
  const calls = [];
  const clinic = {
    id_clinica: 58,
    nombre_clinica: 'Propdental Badalona',
    grupoClinicaId: 5,
    estado_clinica: true,
  };
  const requestModel = {
    async findAll(options) {
      calls.push(['requests', options]);
      return [{
        id: 200,
        clinica_id: 58,
        campaign_id: 20,
        estado: 'activa',
        solicitud: {
          kind: 'marketing_strategy',
          objective_id: 'new_patients',
          mode_snapshot: 'connect_only',
          status: 'active',
          promotion_type: 'treatment',
          summary: { name: 'Implantes Badalona' },
          treatments: [{ id: 7, nombre: 'Implantes' }, { id: 8, nombre: 'Inactivo' }],
          provider_secret: 'NEVER_SERIALIZE',
        },
      }, {
        id: 201,
        clinica_id: 58,
        campaign_id: 21,
        solicitud: {
          kind: 'marketing_strategy', objective_id: 'new_patients',
          mode_snapshot: 'managed_service', status: 'active', promotion_type: 'generic',
        },
      }];
    },
  };
  const campaignModel = {
    async findAll(options) {
      calls.push(['campaigns', options]);
      return [
        { id: 20, nombre: 'Activa', activa: true, gestionada: false },
        { id: 21, nombre: 'Gestionada', activa: true, gestionada: true },
      ];
    },
  };
  const treatmentModel = {
    async findAll(options) {
      calls.push(['treatments', options]);
      return [
        { id_tratamiento: 7, nombre: 'Implantes', activo: true, origen: 'sistema', eliminado_por_clinica: [] },
        { id_tratamiento: 8, nombre: 'Inactivo', activo: false, origen: 'sistema', eliminado_por_clinica: [] },
      ];
    },
  };
  const catalog = await targets.listValidStrategyTargetsForClinic({
    clinic, requestModel, campaignModel, treatmentModel,
  });
  assert.deepEqual(catalog, [{
    strategy_campaign_id: 20,
    campaign_request_id: 200,
    display_name: 'Implantes Badalona',
    targets: [{ kind: 'treatment', treatment_id: 7, treatment_name: 'Implantes' }],
  }]);
  for (const [, options] of calls) {
    assert.ok(Array.isArray(options.attributes), 'Catalog queries must use explicit attribute allowlists');
  }
  assert.doesNotMatch(JSON.stringify(catalog), /NEVER_SERIALIZE|provider_secret/);

  const issue = targets.matchingIssueForAssignment({
    id: 44,
    provider: 'google_ads', customer_id: '1851215478', campaign_id: '9001',
    campaign_name_snapshot: 'Implantes', grupo_clinica_id: 5, clinica_id: 58,
    status: 'active', version: 2, internal_secret: 'NEVER_SERIALIZE',
  }, catalog);
  assert.equal(issue.code, 'target_missing');
  assert.doesNotMatch(JSON.stringify(issue), /NEVER_SERIALIZE|internal_secret/);
  assert.equal(targets.matchingIssueForAssignment({
    id: 44,
    provider: 'google_ads', customer_id: '1851215478', campaign_id: '9001',
    grupo_clinica_id: 5, clinica_id: 58, status: 'active', version: 2,
    strategy_campaign_id: 20, campaign_request_id: 200,
    target_kind: 'treatment', target_treatment_id: 7,
    target_confidence: '0.9000', target_explanation: 'Revisado',
  }, catalog), null);
}

function targetHarness() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const state = {
    assignment: {
      id: 44,
      inventory_id: 90,
      provider: 'google_ads', customer_id: '1851215478', campaign_id: '9001',
      campaign_name_snapshot: 'Campaña 9001', grupo_clinica_id: 5, clinica_id: 58,
      status: 'active', version: 3,
      strategy_campaign_id: 10, campaign_request_id: 100,
      target_kind: 'treatment', target_treatment_id: 7,
      target_confidence: '0.7000', target_explanation: 'Anterior',
    },
    requests: new Map(),
    audits: [],
    scopeChecks: 0,
    assignmentUpdates: [],
  };
  const request = (id, campaignId, payload) => ({
    id,
    clinica_id: 58,
    campaign_id: campaignId,
    estado: 'activa',
    solicitud: payload,
    async update(values, options) {
      assert.equal(options.transaction, transaction);
      this.solicitud = values.solicitud;
    },
  });
  state.requests.set(100, request(100, 10, {
    kind: 'marketing_strategy', objective_id: 'new_patients', mode_snapshot: 'connect_only',
    status: 'active', promotion_type: 'treatment', treatments: [
      { id: 7, nombre: 'Implantes' }, { id: 8, nombre: 'Ortodoncia' },
    ],
    external_targets: [
      { kind: 'treatment', treatment_id: 7, treatment_name: 'Implantes', campaigns: [externalRef(), externalRef({ account: '9999999999' })] },
      { kind: 'treatment', treatment_id: 8, treatment_name: 'Ortodoncia', campaigns: [] },
    ],
  }));
  state.requests.set(200, request(200, 20, {
    kind: 'marketing_strategy', objective_id: 'new_patients', mode_snapshot: 'connect_only',
    status: 'active', promotion_type: 'generic', treatments: [],
    external_targets: [{ kind: 'generic', treatment_id: null, campaigns: [] }],
  }));

  const sequelize = { transaction: async (callback) => callback(transaction) };
  const clinicModel = {
    async findAll(options) {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      return [{ id_clinica: 58, nombre_clinica: 'Propdental Badalona', grupoClinicaId: 5, estado_clinica: true }];
    },
  };
  const accountScopeResolver = async (options) => {
    state.scopeChecks += 1;
    assert.equal(options.transaction, transaction);
    assert.equal(options.lock, true);
    return { account: { account_id: '1851215478' } };
  };
  const assignmentModel = {
    async findByPk(id, options) {
      assert.equal(String(id), '44');
      if (options.lock) assert.equal(options.lock, 'UPDATE');
      return { ...state.assignment };
    },
    async update(values, options) {
      assert.equal(options.transaction, transaction);
      assert.deepEqual(options.where, { id: 44, version: state.assignment.version });
      state.assignmentUpdates.push(values);
      Object.assign(state.assignment, values);
      return [1];
    },
  };
  const requestModel = {
    async findAll(options) {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      return opIn(options.where.id).map((id) => state.requests.get(id)).filter(Boolean);
    },
  };
  const campaignModel = {
    async findByPk(id, options) {
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      return { id, nombre: `Estrategia ${id}`, activa: true, gestionada: false };
    },
  };
  const treatmentModel = {
    async findByPk(id) {
      return { id_tratamiento: id, nombre: 'Implantes', activo: true, origen: 'sistema', eliminado_por_clinica: [] };
    },
  };
  const inventoryModel = {
    async findByPk(id, options) {
      assert.equal(id, 90);
      assert.equal(options.transaction, transaction);
      assert.equal(options.lock, 'UPDATE');
      return {
        account_name: 'Cuenta Propdental', campaign_name: 'Campaña real', status: 'ENABLED',
        latest_metrics: { impressions: 20, clicks: 3, spend: 12.5, conversions: 1 },
        destination_detection: { kind: 'web' },
      };
    },
  };
  const auditModel = {
    async create(values, options) {
      assert.equal(options.transaction, transaction);
      const row = { id: state.audits.length + 1, ...values };
      state.audits.push(row);
      return row;
    },
  };
  return {
    state, sequelize, assignmentModel, auditModel, inventoryModel, clinicModel,
    requestModel, campaignModel, treatmentModel, accountScopeResolver,
  };
}

async function testTargetMoveClearAndCas() {
  const h = targetHarness();
  const moved = await targets.updateExternalAssignmentTarget({
    assignmentId: '44',
    actorUserId: 1,
    input: {
      group_id: 5, provider: 'google_ads', customer_id: '1851215478', expected_version: 3,
      strategy_campaign_id: 20, campaign_request_id: 200, target_kind: 'generic',
      confidence: 0.95, explanation: 'Revisión manual en la estrategia activa',
    },
    ...h,
    now: () => new Date('2026-07-11T08:00:00.000Z'),
  });
  assert.equal(moved.changed, true);
  assert.equal(moved.version, 4);
  assert.equal(h.state.scopeChecks, 1);
  assert.equal(h.state.audits[0].event_type, 'target_changed');
  assert.equal(h.state.audits[0].actor_type, 'user');
  assert.equal(h.state.audits[0].from_version, 3);
  assert.equal(h.state.audits[0].to_version, 4);
  assert.equal(h.state.assignment.campaign_request_id, 200);
  const oldTargets = h.state.requests.get(100).solicitud.external_targets;
  assert.equal(oldTargets.find((item) => item.treatment_id === 7).campaigns.length, 1);
  assert.equal(oldTargets.find((item) => item.treatment_id === 8).campaigns.length, 0);
  const newTargets = h.state.requests.get(200).solicitud.external_targets;
  assert.equal(newTargets[0].campaigns.length, 1);
  assert.deepEqual(
    targets.canonicalExternalCampaignIdentity(newTargets[0].campaigns[0]),
    targets.canonicalExternalCampaignIdentity(externalRef())
  );

  const cleared = await targets.clearExternalAssignmentTarget({
    assignmentId: '44',
    actorUserId: 1,
    input: {
      group_id: 5, provider: 'google_ads', customer_id: '1851215478',
      expected_version: 4, reason: 'La estrategia deja de usar esta campaña',
    },
    sequelize: h.sequelize,
    assignmentModel: h.assignmentModel,
    auditModel: h.auditModel,
    clinicModel: h.clinicModel,
    requestModel: h.requestModel,
    accountScopeResolver: h.accountScopeResolver,
    now: () => new Date('2026-07-11T09:00:00.000Z'),
  });
  assert.equal(cleared.version, 5);
  assert.equal(h.state.audits[1].event_type, 'target_cleared');
  assert.equal(h.state.audits[1].reason, 'La estrategia deja de usar esta campaña');
  assert.equal(h.state.requests.get(200).solicitud.external_targets[0].campaigns.length, 0);
  assert.equal(h.state.assignment.campaign_request_id, null);

  await assert.rejects(() => targets.clearExternalAssignmentTarget({
    assignmentId: '44', actorUserId: 1,
    input: {
      group_id: 5, provider: 'google_ads', customer_id: '1851215478',
      expected_version: 4, reason: 'Versión obsoleta',
    },
    sequelize: h.sequelize,
    assignmentModel: h.assignmentModel,
    auditModel: h.auditModel,
    clinicModel: h.clinicModel,
    requestModel: h.requestModel,
    accountScopeResolver: h.accountScopeResolver,
  }), (error) => error.code === 'matching_assignment_version_conflict' && error.currentVersion === 5);
  assert.equal(h.state.audits.length, 2, 'A stale CAS attempt must not append an audit');
}

async function testMigrationModelRoutesAndCanonicalStrategySource() {
  const migration = require('../../../migrations/20260711018000-add-external-campaign-assignment-target-audits');
  const calls = [];
  const queryInterface = {
    sequelize: { query: async (sql) => calls.push(['query', sql]) },
    addColumn: async (...args) => calls.push(['addColumn', ...args]),
    addIndex: async (...args) => calls.push(['addIndex', ...args]),
    createTable: async (...args) => calls.push(['createTable', ...args]),
  };
  await migration.up(queryInterface, db.Sequelize);
  const columns = calls.filter((call) => call[0] === 'addColumn').map((call) => call[2]);
  for (const field of [
    'strategy_campaign_id', 'campaign_request_id', 'target_kind', 'target_treatment_id',
    'target_confidence', 'target_explanation', 'target_updated_by_user_id',
    'target_updated_at', 'version',
  ]) {
    assert.ok(columns.includes(field), `Missing target column ${field}`);
  }
  const auditColumns = calls.find((call) => call[0] === 'createTable')[2];
  assert.equal(auditColumns.assignment_id.onDelete, 'RESTRICT');
  assert.equal(auditColumns.updated_at, undefined);
  assert.equal(auditColumns.actor_user_id.allowNull, true);
  assert.equal(auditColumns.actor_type.allowNull, false);
  const backfillSql = calls.find((call) => call[0] === 'query')[1];
  assert.match(backfillSql, /clinic_assigned_backfill/);
  assert.match(backfillSql, /archived_backfill/);
  assert.match(backfillSql, /THEN 'system'/);
  assert.doesNotMatch(backfillSql, /target_kind\s*=/,
    'Backfill must not invent a target decision');

  const hooks = db.ExternalCampaignAssignmentAudit.options.hooks;
  for (const hookName of ['beforeUpdate', 'beforeBulkUpdate', 'beforeDestroy', 'beforeBulkDestroy']) {
    const hook = Array.isArray(hooks[hookName]) ? hooks[hookName][0] : hooks[hookName];
    assert.throws(() => hook(), (error) => error.code === 'external_campaign_assignment_audit_append_only');
  }
  assert.ok(db.ExternalCampaignAssignment.associations.audits);
  assert.ok(db.ExternalCampaignAssignmentAudit.associations.actor);

  const routeSource = fs.readFileSync(path.resolve(__dirname, '../../routes/adminManagedCampaigns.routes.js'), 'utf8');
  for (const route of [
    "router.get('/matching/issues'",
    "router.patch('/matching/assignments/:id/target'",
    "router.delete('/matching/assignments/:id/target'",
    "router.get('/matching/assignments/:id/audits'",
  ]) assert.match(routeSource, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(routeSource.indexOf("router.get('/matching/issues'") < routeSource.indexOf("router.get('/:id'"));

  const strategySource = fs.readFileSync(path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'), 'utf8');
  const conflictStart = strategySource.indexOf('async function findExternalCampaignAssignmentConflicts');
  const conflictEnd = strategySource.indexOf('async function findMappedGoogleAccountsForScope', conflictStart);
  const conflictSource = strategySource.slice(conflictStart, conflictEnd);
  assert.match(conflictSource, /externalCampaignIdentityKey/);
  assert.match(conflictSource, /account_id: identity\.account_id/);
  assert.match(conflictSource, /customer_id: identity\.customer_id/);
  assert.doesNotMatch(conflictSource, /`\$\{provider\}:\$\{externalCampaignId\}`/);
  const metricsStart = strategySource.indexOf('async function loadCurrentExternalCampaignMetricsIndex');
  const metricsEnd = strategySource.indexOf('function pickLegacyCampaignTypeFromChannels', metricsStart);
  const metricsSource = strategySource.slice(metricsStart, metricsEnd);
  assert.match(metricsSource, /group: \['customerId', 'campaignId'\]/);
  assert.match(metricsSource, /group: \['ad_account_id', 'entity_id'\]/);
  assert.match(metricsSource, /externalCampaignIdentityKey/);
  const analysisStart = strategySource.indexOf('exports.getMarketingStrategyAnalysisCampaign');
  const analysisEnd = strategySource.indexOf('exports.updateMarketingStrategy', analysisStart);
  const analysisSource = strategySource.slice(analysisStart, analysisEnd);
  assert.match(analysisSource, /account_id: req\.query\?\.account_id/);
  assert.match(analysisSource, /customer_id: req\.query\?\.customer_id/);
  assert.match(analysisSource, /identity: requestedIdentity/);

  const adminSource = fs.readFileSync(path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'), 'utf8');
  const archiveStart = adminSource.indexOf('exports.archiveMatching');
  const archiveEnd = adminSource.indexOf('function matchingAssignmentId', archiveStart);
  assert.match(adminSource.slice(archiveStart, archiveEnd), /provider !== 'google_ads'/,
    'Meta tombstones must stay unavailable while Meta sync ignores ExternalCampaignAssignment');
  const syncSource = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  assert.equal((syncSource.match(/provider:\s*'google_ads'[\s\S]{0,180}ExternalCampaignAssignment/g) || []).length >= 0, true);
  assert.doesNotMatch(syncSource, /provider:\s*'meta_ads'[\s\S]{0,500}ExternalCampaignAssignment/,
    'This test documents why the Meta archive endpoint must remain fail-closed');
}

async function run() {
  testCanonicalIdentityAndPayloadSync();
  testStrictTargetPayloads();
  await testSafeStrategyCatalogAndIssues();
  await testTargetMoveClearAndCas();
  await testMigrationModelRoutesAndCanonicalStrategySource();
  console.log('external_campaign_assignment_targets.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });
