'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DataTypes, Sequelize, Op } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const define = (name, columns, options = {}) => models[name] = sql.define(name, columns, { timestamps: false, ...options });
  for (const file of ['campaignworkspacesetting', 'campaignworkspaceevent', 'jobrequest', 'campaignworkspaceoptimizationrun']) {
    const model = require(`../../../models/${file}`)(sql, DataTypes); models[model.name] = model;
  }
  define('Clinica', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true }, grupoClinicaId: DataTypes.INTEGER, estado_clinica: DataTypes.BOOLEAN });
  define('UsuarioClinica', { id_usuario: DataTypes.INTEGER, id_clinica: DataTypes.INTEGER, rol_clinica: DataTypes.STRING, estado_invitacion: DataTypes.STRING });
  define('ClinicGoogleAdsAccount', { customerId: DataTypes.STRING });
  define('ClinicMetaAsset', { assetType: DataTypes.STRING, metaAssetId: DataTypes.STRING });
  define('CampaignOptimizationPolicy', { scopeType: DataTypes.STRING, scopeId: DataTypes.INTEGER, status: DataTypes.STRING });
  define('IntakeConfig', { clinic_id: DataTypes.INTEGER, group_id: DataTypes.INTEGER, assignment_scope: DataTypes.STRING, config: DataTypes.JSON });
  define('CampaignRequest', { clinica_id: DataTypes.INTEGER, solicitud: DataTypes.JSON, estado: DataTypes.STRING,
    created_at: DataTypes.DATE, updated_at: DataTypes.DATE });
  // SQL-backed fixtures stand in for external inventory/grants, not transaction or authorization logic.
  define('QaCampaign', { provider: DataTypes.STRING, account_id: DataTypes.STRING, campaign_id: DataTypes.STRING, clinicId: DataTypes.INTEGER });
  define('QaGrant', { provider: DataTypes.STRING, account_id: DataTypes.STRING, fingerprint: DataTypes.STRING, active: DataTypes.BOOLEAN });
  for (const [name, model] of Object.entries(models)) if (name !== 'sequelize' && name !== 'CampaignWorkspaceOptimizationRun') await model.sync();
  const migration = require('../../../migrations/20260911180000-create-campaign-workspace-optimization-runs');
  await migration.up(sql.getQueryInterface(), Sequelize); await migration.up(sql.getQueryInterface(), Sequelize);

  const { optimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
  const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
  const { resolveOptimizationAuthorization, pauseWorkspaceOptimization, LIMITS } = require('../../services/campaignWorkspaceOptimizationAuthorization.service');
  const { hasMarketingClinicScopeAccess } = require('../../lib/marketingScopeAccess');
  const { enqueueOptimizationAdjustment, runOptimizationAdjustmentJob, recoverOptimizationRuns, LEASE_MS } = require('../../services/campaignWorkspaceOptimizationExecution.service');
  const { budgetPeriod, cents } = require('../../services/campaignWorkspaceBudgetSnapshot.service');
  const { currentProof } = require('./fixtures/campaign_workspace_current_proof.fixture');
  const transactionOptions = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  const runtime = { now: new Date('2026-09-11T12:00:00Z'), remote: new Map(), reads: 0, writes: 0, jobs: [], connections: new Set() };
  sql.addHook('afterConnect', connection => { runtime.connections.add(connection.threadId); });
  const [connectionRows] = await sql.query('SELECT CONNECTION_ID() AS id'); runtime.connections.add(connectionRows[0].id);

  const loadInventory = async ({ scope, transaction }) => ({ campaigns: (await models.QaCampaign.findAll({
    where: { clinicId: { [Op.in]: scope.clinicIds } }, raw: true, ...transactionOptions(transaction),
  })).map(row => ({ ...row, id: `${row.provider}:${row.account_id}:${row.campaign_id}`, assigned: true })) });
  const resolveContext = async ({ scope, reference, transaction }) => {
    const options = transactionOptions(transaction);
    const setting = await models.CampaignWorkspaceSetting.findOne({ where: { scope_type: scope.groupId ? 'group' : 'clinic',
      scope_id: scope.groupId || scope.clinicIds[0] }, ...options });
    const campaign = await models.QaCampaign.findOne({ where: reference, ...options });
    const grant = await models.QaGrant.findOne({ where: { provider: reference.provider, account_id: reference.account_id }, ...options });
    if (!grant?.active) throw Object.assign(Error('workspace_optimization_permissions_required'), { code: 'workspace_optimization_permissions_required' });
    return { setting, reference, campaign: campaign && { ...campaign.get({ plain: true }),
      id: `${campaign.provider}:${campaign.account_id}:${campaign.campaign_id}`, assigned: true }, grant: { fingerprint: grant.fingerprint,
      connection: { id: grant.id, accessToken: 'synthetic-only' }, loginCustomerId: null } };
  };
  const enqueue = async (request, options) => {
    const job = await models.JobRequest.create({ ...request, max_attempts: request.maxAttempts }, options);
    runtime.jobs.push(job.id); return { job, created: true };
  };
  const hasAccess = options => hasMarketingClinicScopeAccess({ ...options, membershipModel: options.membershipModel || models.UsuarioClinica, globalAdminCheck: () => false });
  const budgetRead = async ({ reference, now }) => {
    const changes = [...runtime.remote.values()].filter(item => item.change.target.action === 'adjust_budget'
      && digest(item.change.reference) === digest(reference));
    const body = { schema_version: 1, reference, period: budgetPeriod(now), currency: 'EUR', time_zone: 'Europe/Madrid',
      observed_at: now.toISOString(), spent_cents: 500,
      resources: changes.map(({ change, value }) => ({ resource: change.target.resource, unit: change.target.unit,
        amount: value, daily_cents: cents(value, change.target.unit) })) };
    return { ...body, fingerprint: digest(body) };
  };
  const deps = { models, namespace: 'isolated-mysql-test', now: () => runtime.now,
    env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true', CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'true' },
    hasAccess, authorize: input => resolveOptimizationAuthorization({ ...input, resolveContext, loadInventory }),
    enqueue, ensureToken: async () => ({ accessToken: 'synthetic-only' }),
    read: async change => { runtime.reads++; return runtime.remote.get(change.target.resource).value; },
    inspect: async () => {},
    mutate: async change => {
      const receipt = await models.CampaignWorkspaceOptimizationRun.findOne({ where: { plan_key: { [Op.ne]: '' },
        status: 'submitted', campaign_id: change.reference.campaign_id } });
      assert.ok(receipt?.submitted_at, 'Submission is durable before simulated HTTP');
      if (change.target.action === 'adjust_budget') assert.ok(receipt.outcome.budget_accounting?.fingerprint);
      runtime.writes++; runtime.remote.get(change.target.resource).value = change.after; return { acknowledged: true };
    },
    budgetDependencies: { now: () => runtime.now, loadInventory, resolveContext,
      ensureToken: async () => ({ accessToken: 'synthetic-only' }), inspectGoogleBudget: budgetRead, inspectMetaBudget: budgetRead },
    receptionDependencies: { loadInventory, loadReception: async ({ campaigns }) => new Map(campaigns.map(campaign =>
      [campaign.id, { reception: { checked: true, ready: true, state: 'verified' } }])) },
  };

  async function seed(provider, clinic = 1, account = '20', campaign = '30', action = 'adjust_bids', resourceId = '50', append = false) {
    const reference = { provider, account_id: account, campaign_id: campaign }; const google = provider === 'google_ads';
    const target = action === 'adjust_budget' ? { action, entity: google ? 'campaign_budget' : 'ad_set', id: resourceId,
      resource: google ? `customers/${account}/campaignBudgets/${resourceId}` : resourceId,
      field: google ? 'amount_micros' : 'daily_budget', unit: google ? 'micros' : 'minor' }
      : action === 'pause_underperforming_ads' ? { action, entity: 'ad', id: resourceId, group_id: '50',
        resource: google ? `customers/${account}/adGroupAds/50~${resourceId}` : resourceId, field: 'status' }
      : { action, entity: google ? 'ad_group' : 'ad_set', id: resourceId,
        resource: google ? `customers/${account}/adGroups/${resourceId}` : resourceId,
        field: google ? 'cpc_bid_micros' : 'bid_amount', unit: google ? 'micros' : 'minor', strategy: google ? 'MANUAL_CPC' : 'LOWEST_COST_WITH_BID_CAP' };
    const change = optimizationChange({ reference, target, before: action === 'pause_underperforming_ads' ? (google ? 'ENABLED' : 'ACTIVE') : '1000',
      after: action === 'pause_underperforming_ads' ? 'PAUSED' : '950' });
    await models.Clinica.findOrCreate({ where: { id_clinica: clinic }, defaults: { grupoClinicaId: null, estado_clinica: true } });
    await models.UsuarioClinica.findOrCreate({ where: { id_usuario: 901, id_clinica: clinic }, defaults: { rol_clinica: 'agencia', estado_invitacion: 'aceptada' } });
    await (google ? models.ClinicGoogleAdsAccount : models.ClinicMetaAsset).findOrCreate({ where: google ? { customerId: account } : { assetType: 'ad_account', metaAssetId: account } });
    const [grant] = await models.QaGrant.findOrCreate({ where: { provider, account_id: account }, defaults: { fingerprint: 'a'.repeat(64), active: true } });
    await models.QaCampaign.create({ ...reference, clinicId: clinic });
    let setting = append && await models.CampaignWorkspaceSetting.findOne({ where: { scope_type: 'clinic', scope_id: clinic } });
    if (setting) {
      const activation = structuredClone(setting.activation); activation.optimization.authorization.campaigns.push({ ...reference,
        clinic_id: clinic, connection_id: grant.id, grant_fingerprint: grant.fingerprint, login_customer_id: null, targets: [target] });
      await setting.update({ activation, version: setting.version + 1,
        accounts: [...setting.accounts, { provider, account_id: account, include_future: true, campaign_ids: [] }] });
    } else setting = await models.CampaignWorkspaceSetting.create({ id: crypto.randomUUID(), scope_type: 'clinic', scope_id: clinic,
      version: 1, updated_by_user_id: 901, accounts: [{ provider, account_id: account, include_future: true, campaign_ids: [] }],
      activation: { schema_version: 2, mode: 'optimize', status: 'active', optimization: { schema_version: 1,
        id: crypto.randomUUID(), status: 'active', authorized_at: runtime.now.toISOString(), authorized_by_user_id: 901,
        authorization: { schema_version: 1, clinic_ids: [clinic], limits: { ...LIMITS, actions: [action], currency: 'EUR',
          monthly_limit_cents: action === 'adjust_budget' ? 100000 : null },
        campaigns: [{ ...reference, clinic_id: clinic, connection_id: grant.id, grant_fingerprint: grant.fingerprint,
          login_customer_id: null, targets: [target] }] } } } });
    runtime.remote.set(target.resource, { change, value: change.before });
    const proof = async (command = change, cycle = 'sql-executor-test', direction = 'decrease') => {
      await setting.reload(); const scope = { groupId: setting.scope_type === 'group' ? setting.scope_id : null,
        clinicIds: setting.activation.optimization.authorization.clinic_ids };
      const source = await deps.authorize({ models, setting, scope, campaign: reference, action, now: runtime.now, hasAccess });
      return currentProof({ setting, scope, source, change: command, now: runtime.now, cycle, direction });
    };
    const evidence = action === 'pause_underperforming_ads' ? null : await proof();
    return { setting, change, evidence, proof, enqueue: patch => enqueueOptimizationAdjustment({ settingId: setting.id,
      mandateId: setting.activation.optimization.id, change, evidence, ...patch }, deps) };
  }
  async function run(jobId, overrides = {}) {
    const job = await models.JobRequest.findByPk(jobId); await job.update({ status: 'running' });
    const result = await runOptimizationAdjustmentJob(job.payload, job, { ...deps, ...overrides, readOnly: job.type.endsWith('_check') });
    await job.update({ status: result.status === 'failed' && result.retryable ? 'waiting' : result.status });
    return result;
  }

  async function pauseProposal(f, candidateId = '60') {
    const provider = f.change.reference.provider;
    const fixture = require('./fixtures/campaign_workspace_optimization_evidence.fixture').qualifiedFixture(provider);
    fixture.state.now = runtime.now;
    const collection = (await fixture.run()).evidence;
    const setting = await f.setting.reload(); const scope = { groupId: null, clinicIds: [1] };
    const source = await deps.authorize({ models, setting, scope, campaign: f.change.reference,
      action: 'pause_underperforming_ads', hasAccess, now: runtime.now });
    for (const ad of collection.performance.inventory) if (ad.id === '60') ad.id = candidateId;
    for (const day of [...collection.performance.ad_daily, ...collection.attribution.ad_daily]) if (day.ad_id === '60') day.ad_id = candidateId;
    collection.performance.inventory.sort((a, b) => `${a.group_id}~${a.id}`.localeCompare(`${b.group_id}~${b.id}`));
    collection.performance.ad_daily.sort((a, b) => `${a.date}:${a.group_id}:${a.ad_id}`.localeCompare(`${b.date}:${b.group_id}:${b.ad_id}`));
    const { fingerprint: _, ...performance } = collection.performance;
    collection.performance.fingerprint = digest(performance);
    Object.assign(collection, { setting_id: setting.id, mandate_id: setting.activation.optimization.id,
      authorization_targets: source.entry.targets, source_fingerprint: require('../../services/campaignWorkspaceOptimizationEvidence.service').sourceStamp(setting, scope, source) });
    const { fingerprint: ignored, ...body } = collection;
    collection.fingerprint = digest(body);
    const [proposal] = require('../../services/campaignWorkspaceAdPausePolicy.service').buildAdPauseProposals(collection,
      { evaluationKey: digest([setting.id, candidateId, 'isolated-sql-cycle']), now: runtime.now });
    assert.ok(proposal);
    runtime.remote.set(proposal.change.target.resource, { change: proposal.change, value: proposal.change.before });
    const overrides = { inspect: async () => ({ reference: f.change.reference, currency: 'EUR', targets: [{
      ...proposal.change.target, id: '61', resource: provider === 'google_ads' ? 'customers/20/adGroupAds/50~61' : '61', value: proposal.change.before,
    }] }), receptionDependencies: { loadInventory, loadReception: async () => new Map([
      [`${provider}:20:30`, { reception: { checked: true, ready: true, state: 'verified' } }],
    ]) } };
    return { ...proposal, overrides, enqueue: () => f.enqueue(proposal) };
  }

  async function bidProposal(f, cycle = 'sql-bid-cycle') {
    const provider = f.change.reference.provider;
    const fixture = require('./fixtures/campaign_workspace_bid.fixture').bidFixture(provider);
    const activation = structuredClone(f.setting.activation);
    if (provider === 'meta_ads' && activation.optimization.authorization.campaigns[0].targets[0].strategy !== 'LOWEST_COST_WITH_BID_CAP') {
      activation.optimization.authorization.campaigns[0].targets[0].strategy = 'LOWEST_COST_WITH_BID_CAP';
      await f.setting.update({ activation, version: f.setting.version + 1 });
    }
    fixture.state.now = runtime.now;
    const current = runtime.remote.get(f.change.target.resource).value;
    if (provider === 'google_ads') fixture.state.bidGroups[0].adGroup.cpcBidMicros = current;
    else fixture.state.bidGroups[0].bid_amount = current;
    const { evidence: collection } = await fixture.run(); assert.ok(collection);
    const setting = await f.setting.reload(); const scope = { groupId: null, clinicIds: [1] };
    const source = await deps.authorize({ models, setting, scope, campaign: f.change.reference, action: 'adjust_bids', hasAccess, now: runtime.now });
    Object.assign(collection, { setting_id: setting.id, mandate_id: setting.activation.optimization.id,
      authorization_targets: source.entry.targets, source_fingerprint: require('../../services/campaignWorkspaceOptimizationEvidence.service').sourceStamp(setting, scope, source) });
    const { fingerprint, ...body } = collection; collection.fingerprint = digest(body);
    const [proposal] = require('../../services/campaignWorkspaceBidPolicy.service').buildBidProposals(collection,
      { evaluationKey: digest([setting.id, cycle]), now: runtime.now }); assert.ok(proposal);
    const overrides = { inspect: async () => ({ reference: f.change.reference, currency: 'EUR', targets: [{ ...proposal.change.target, value: current }] }),
      receptionDependencies: { loadInventory, loadReception: async () => new Map([
        [`${provider}:20:30`, { reception: { checked: true, ready: true, state: 'verified' } }],
      ]) } };
    return { ...proposal, overrides, enqueue: () => f.enqueue(proposal) };
  }
  async function budgetProposal(f, cycle = 'sql-budget-cycle', increase = false) {
    const provider = f.change.reference.provider;
    const fixture = require('./fixtures/campaign_workspace_budget_policy.fixture').budgetPolicyFixture(provider);
    fixture.state.now = runtime.now;
    const current = runtime.remote.get(f.change.target.resource).value;
    if (provider === 'google_ads') fixture.state.googleMeta[0].campaignBudget.amountMicros = current;
    else fixture.state.bidGroups[0].daily_budget = current;
    if (increase) fixture.setDailyCosts(100, 50);
    const { evidence: collection } = await fixture.run(); assert.ok(collection);
    const setting = await f.setting.reload(); const scope = { groupId: null, clinicIds: [1] };
    const source = await deps.authorize({ models, setting, scope, campaign: f.change.reference, action: 'adjust_budget', hasAccess, now: runtime.now });
    Object.assign(collection, { setting_id: setting.id, mandate_id: setting.activation.optimization.id,
      authorization_targets: source.entry.targets, source_fingerprint: require('../../services/campaignWorkspaceOptimizationEvidence.service').sourceStamp(setting, scope, source) });
    const { fingerprint, ...body } = collection; collection.fingerprint = digest(body);
    const [proposal] = require('../../services/campaignWorkspaceBudgetPolicy.service').buildBudgetProposals(collection,
      { evaluationKey: digest([setting.id, cycle]), now: runtime.now }); assert.ok(proposal);
    const overrides = { inspect: async () => ({ reference: f.change.reference, currency: 'EUR', targets: [{ ...proposal.change.target, value: current }] }),
      receptionDependencies: { loadInventory, loadReception: async () => new Map([
        [`${provider}:20:30`, { reception: { checked: true, ready: true, state: 'verified' } }],
      ]) } };
    return { ...proposal, overrides, enqueue: () => f.enqueue(proposal) };
  }
  async function budgetSeed(provider) {
    const f = await seed(provider, 1, '20', '30', 'adjust_budget', provider === 'google_ads' ? '70' : '50');
    const activation = structuredClone(f.setting.activation); activation.optimization.authorization.limits.monthly_limit_cents = 500000;
    await f.setting.update({ activation });
    runtime.remote.get(f.change.target.resource).value = provider === 'google_ads' ? '50000000' : '5000';
    return f;
  }
  async function targetBidProposal(f, strategy = 'MAXIMIZE_CONVERSIONS', cycle = 'sql-target-cycle') {
    const fixture = require('./fixtures/campaign_workspace_target_bid.fixture').targetBidFixture(strategy,
      strategy.startsWith('MAXIMIZE') ? 'PERFORMANCE_MAX' : 'SEARCH');
    fixture.state.now = runtime.now;
    const activation = structuredClone(f.setting.activation);
    activation.optimization.authorization.campaigns[0].targets = [fixture.target];
    await f.setting.update({ activation, version: f.setting.version + 1 });
    const collection = (await fixture.run()).evidence; assert.ok(collection);
    const scope = { groupId: null, clinicIds: [1] };
    const source = await deps.authorize({ models, setting: f.setting, scope, campaign: f.change.reference,
      action: 'adjust_bids', hasAccess, now: runtime.now });
    Object.assign(collection, { setting_id: f.setting.id, mandate_id: f.setting.activation.optimization.id,
      authorization_targets: source.entry.targets, source_fingerprint: require('../../services/campaignWorkspaceOptimizationEvidence.service').sourceStamp(f.setting, scope, source) });
    const { fingerprint, ...body } = collection; collection.fingerprint = digest(body);
    const [proposal] = require('../../services/campaignWorkspaceTargetBidPolicy.service').buildTargetBidProposals(collection,
      { evaluationKey: digest([f.setting.id, cycle]), now: runtime.now }); assert.ok(proposal);
    runtime.remote.delete(f.change.target.resource);
    runtime.remote.set(proposal.change.target.resource, { change: proposal.change, value: proposal.change.before });
    return { ...proposal, fixture, enqueue: () => f.enqueue(proposal), overrides: {
      targetDependencies: { googleRequest: fixture.snapshot.request, clock: () => fixture.snapshot.state.clock },
      inspect: async () => ({ reference: proposal.change.reference, currency: 'EUR', targets: [{ ...proposal.change.target,
        value: runtime.remote.get(proposal.change.target.resource).value }] }),
    } };
  }
  async function check(name, test) {
    try { await test(); report.checks.push(name); console.log('OK ' + name); }
    catch (error) { throw Object.assign(Error(`${name}: ${error.message}`), { cause: error, original: error.original }); }
  }
  async function clear() {
    for (const model of [models.CampaignWorkspaceOptimizationRun, models.JobRequest, models.CampaignWorkspaceEvent, models.CampaignWorkspaceSetting,
      models.QaCampaign, models.QaGrant, models.UsuarioClinica, models.Clinica, models.ClinicGoogleAdsAccount, models.ClinicMetaAsset]) await model.destroy({ where: {} });
    runtime.now = new Date('2026-09-11T12:00:00Z'); runtime.writes = 0; runtime.reads = 0; runtime.remote.clear(); runtime.jobs = [];
  }

  for (const kind of ['google_negative', 'meta_pending', 'meta_mixed']) {
    await clear();
    await check(`${kind}: SQL compatibility preserves provider evidence but authorizes only implemented policies`, async () => {
      const f = require('./fixtures/campaign_workspace_availability.fixture').availabilityFixture(kind);
      const { loadOptimizationAuthorizationReview, createOptimizationMandate } = require('../../services/campaignWorkspaceOptimizationAuthorization.service');
      const setting = await models.CampaignWorkspaceSetting.create({ ...f.setting, updated_by_user_id: 901 });
      const event = await models.CampaignWorkspaceEvent.create({ id: crypto.randomUUID(), setting_id: setting.id, version: setting.version,
        event_type: 'optimization_check', actor_user_id: 901, created_at: runtime.now, changes: f.context.latest });
      const result = await loadOptimizationAuthorizationReview({ models, scope: f.scope, setting, campaigns: [f.campaign], now: runtime.now,
        resolveContext: async () => ({ ...f.context, setting: await setting.reload(), latest: (await event.reload()).changes }) });
      const mixed = kind === 'meta_mixed'; assert.equal(result.review.ready, mixed);
      if (mixed) {
        const mandate = createOptimizationMandate({ authorization: result.authorization, actorId: 901, now: runtime.now });
        assert.equal(mandate.authorization.campaigns[0].targets.length, 3);
        assert.ok(mandate.authorization.campaigns[0].targets.every(target => target.strategy !== 'COST_CAP'));
        const bids = result.review.campaigns[0].actions.find(action => action.action === 'adjust_bids');
        assert.equal(bids.targets, 1); assert.deepEqual(bids.reasons, ['bid_policy_not_available']);
      } else assert.equal(result.authorization, null);
      assert.deepEqual((await event.reload()).changes, f.context.latest);
      assert.equal((await setting.reload()).activation, null);
      assert.equal(await models.JobRequest.count(), 0); assert.equal(await models.CampaignWorkspaceOptimizationRun.count(), 0);
      assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
    });
  }

  function legacyNegative(f) {
    return { change: optimizationChange({ reference: f.change.reference, before: false, after: 'implantes dentales',
      target: { action: 'negative_keywords', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', field: 'keyword', match_type: 'EXACT' } }),
    evidence: { schema_version: 1, rule: 'search_without_results', observed_at: runtime.now.toISOString(),
      window_start: '2026-09-01', window_end: '2026-09-10', metrics: { clicks: 120, leads: 0, cost_cents: 10000 } } };
  }
  async function seedHistoricalNegative(submitted) {
    const f = await seed('google_ads'); const queued = await f.enqueue(); const historical = legacyNegative(f);
    const activation = structuredClone(f.setting.activation);
    activation.optimization.authorization.limits.actions = ['negative_keywords'];
    activation.optimization.authorization.campaigns[0].targets = [historical.change.target];
    await f.setting.update({ activation });
    const receipt = await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId);
    await receipt.update({ ...historical, plan_key: digest([receipt.mandate_id, historical.change.fingerprint, historical.evidence]),
      resource_key: digest(['google_ads', '20', historical.change.target.resource]),
      status: submitted ? 'uncertain' : 'queued', submitted_at: submitted ? runtime.now : null });
    runtime.remote.clear(); runtime.remote.set(historical.change.target.resource, { change: historical.change, value: false });
    return { f, queued, receipt, historical };
  }
  await clear();
  await check('negative producer rejects zero-result evidence before creating any SQL job or run', async () => {
    const f = await seed('google_ads');
    await assert.rejects(f.enqueue(legacyNegative(f)), /workspace_optimization_search_relevance_required/);
    assert.equal(await models.CampaignWorkspaceOptimizationRun.count(), 0); assert.equal(await models.JobRequest.count(), 0);
    assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
  });
  await clear();
  await check('queued historical negative is skipped with JSON evidence unchanged and without provider I/O', async () => {
    const { queued, receipt, historical } = await seedHistoricalNegative(false);
    const result = await run(queued.jobId); assert.equal(result.error_message, 'workspace_optimization_search_relevance_required');
    await receipt.reload(); assert.equal(receipt.status, 'skipped'); assert.equal(receipt.submitted_at, null);
    assert.deepEqual(receipt.evidence, historical.evidence); assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
  });
  await clear();
  await check('historical submitted negative recovers as read-only and preserves the immutable plan', async () => {
    const { f, queued, receipt, historical } = await seedHistoricalNegative(true); const key = receipt.plan_key;
    await models.JobRequest.update({ status: 'completed' }, { where: { id: queued.jobId } });
    runtime.now = new Date(+receipt.next_check_at + 1);
    const activation = structuredClone(f.setting.activation); activation.optimization.status = 'paused'; await f.setting.update({ activation });
    assert.equal((await recoverOptimizationRuns(deps)).report.check_queued, 1);
    await receipt.reload(); const job = await models.JobRequest.findByPk(receipt.job_request_id);
    assert.equal(job.type, 'campaign_workspace_optimization_check');
    runtime.remote.get(historical.change.target.resource).value = true;
    const result = await run(job.id); assert.equal(result.result?.state, 'observed'); assert.equal(result.result.provider_mutation, false);
    await receipt.reload(); assert.equal(receipt.plan_key, key); assert.deepEqual(receipt.evidence, historical.evidence);
    assert.ok(receipt.submitted_at); assert.equal(runtime.reads, 1); assert.equal(runtime.writes, 0);
  });

  for (const strategy of ['TARGET_CPA', 'MAXIMIZE_CONVERSIONS', 'TARGET_ROAS', 'MAXIMIZE_CONVERSION_VALUE']) {
    await clear();
    await check(`${strategy}: complete goal/recommendation evidence survives SQL and concurrent recovery once`, async () => {
      const f = await seed('google_ads'); const proposal = await targetBidProposal(f, strategy);
      const jobs = await Promise.all([proposal.enqueue(), proposal.enqueue()]); assert.equal(jobs[0].runId, jobs[1].runId);
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(jobs[0].runId);
      const identity = digest([row.change, row.evidence, row.plan_key]); assert.equal(row.evidence.schema_version, 5);
      await models.JobRequest.update({ status: 'failed' }, { where: { id: jobs[0].jobId } });
      runtime.now = new Date(+runtime.now + 60000); await row.update({ next_check_at: new Date(+runtime.now - 1) });
      const reports = await Promise.all([recoverOptimizationRuns(deps), recoverOptimizationRuns(deps)]);
      assert.equal(reports.reduce((count, report) => count + report.report.apply_queued, 0), 1); await row.reload();
      assert.equal(await models.JobRequest.count(), 2);
      const result = await run(row.job_request_id, proposal.overrides); assert.equal(result.result?.state, 'verified', JSON.stringify(result));
      assert.equal(runtime.writes, 1); await row.reload(); assert.equal(digest([row.change, row.evidence, row.plan_key]), identity);
      assert.equal((await run(row.job_request_id, proposal.overrides)).result.idempotent, true); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${strategy}: a provider goal change cancels the SQL proposal without a submission`, async () => {
      const f = await seed('google_ads'); const proposal = await targetBidProposal(f, strategy); const queued = await proposal.enqueue();
      proposal.fixture.snapshot.state.actions[0].conversionAction.countingType = 'MANY_PER_CLICK';
      const result = await run(queued.jobId, proposal.overrides);
      assert.equal(result.result?.reason, 'workspace_optimization_target_changed', JSON.stringify(result));
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId);
      assert.equal(row.submitted_at, null); assert.equal(row.status, 'skipped'); assert.equal(runtime.writes, 0);
    });
  }
  await clear();
  await check('SQL target preflight stops between provider pages after account-grant revocation', async () => {
    const f = await seed('google_ads'); const proposal = await targetBidProposal(f); const queued = await proposal.enqueue();
    const reads = proposal.fixture.snapshot.state.calls.length;
    proposal.fixture.snapshot.state.onRead = async () => { await models.QaGrant.update({ active: false }, { where: { provider: 'google_ads', account_id: '20' } }); };
    const result = await run(queued.jobId, proposal.overrides);
    assert.equal(result.result?.reason, 'workspace_optimization_permissions_required', JSON.stringify(result));
    assert.equal(proposal.fixture.snapshot.state.calls.length, reads + 1); assert.equal(runtime.writes, 0);
    assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId)).submitted_at, null);
  });
  await clear();
  await check('SQL target timeout after submission is recovered by value observation, never recommendation replay', async () => {
    const f = await seed('google_ads'); const proposal = await targetBidProposal(f); const queued = await proposal.enqueue();
    const result = await run(queued.jobId, { ...proposal.overrides, mutate: async () => { runtime.writes++; throw Error('simulated timeout'); } });
    assert.equal(result.result?.state, 'uncertain'); const row = await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId);
    runtime.now = new Date(+row.next_check_at + 1); const count = proposal.fixture.snapshot.state.calls.length;
    assert.equal((await recoverOptimizationRuns(deps)).report.check_queued, 1); await row.reload();
    runtime.remote.get(proposal.change.target.resource).value = proposal.change.after;
    assert.equal((await run(row.job_request_id, proposal.overrides)).result?.state, 'observed');
    assert.equal(runtime.writes, 1); assert.equal(proposal.fixture.snapshot.state.calls.length, count);
  });

  for (const provider of ['google_ads', 'meta_ads']) {
    for (const action of ['adjust_bids', 'adjust_budget']) {
      const oldEvidence = () => ({ schema_version: 1, rule: action === 'adjust_budget' ? 'budget_efficiency' : 'bid_efficiency',
        observed_at: runtime.now.toISOString(), window_start: '2026-09-01', window_end: '2026-09-10',
        metrics: { clicks: 120, leads: 2, cost_cents: 10000, baseline_clicks: 120, baseline_leads: 10, baseline_cost_cents: 10000 } });
      const historical = async submitted => {
        const f = await seed(provider, 1, '20', '30', action); const queued = await f.enqueue();
        const row = await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId); const evidence = oldEvidence();
        await row.update({ evidence, plan_key: digest([row.mandate_id, row.change.fingerprint, evidence]),
          submitted_at: submitted ? runtime.now : null, status: submitted ? 'uncertain' : 'queued' });
        return { f, queued, row, identity: digest([row.change, row.evidence, row.plan_key]) };
      };
      await clear();
      await check(`${provider} ${action}: aggregate-only evidence cannot create a SQL command`, async () => {
        const f = await seed(provider, 1, '20', '30', action);
        await assert.rejects(f.enqueue({ evidence: oldEvidence() }), /workspace_optimization_current_policy_required/);
        assert.equal(await models.CampaignWorkspaceOptimizationRun.count(), 0); assert.equal(await models.JobRequest.count(), 0);
        assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
      });
      await clear();
      await check(`${provider} ${action}: a queued legacy SQL command is skipped without provider access`, async () => {
        const h = await historical(false); const result = await run(h.queued.jobId);
        assert.equal(result.error_message, 'workspace_optimization_current_policy_required');
        await h.row.reload(); assert.equal(h.row.status, 'skipped'); assert.equal(h.row.submitted_at, null);
        assert.equal(digest([h.row.change, h.row.evidence, h.row.plan_key]), h.identity);
        assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
      });
      await clear();
      await check(`${provider} ${action}: concurrent recovery cannot revive old unsubmitted SQL evidence`, async () => {
        const h = await historical(false); await models.JobRequest.update({ status: 'failed' }, { where: { id: h.queued.jobId } });
        runtime.now = new Date(+h.row.next_check_at + 1);
        const reports = await Promise.all([recoverOptimizationRuns(deps), recoverOptimizationRuns(deps)]);
        assert.equal(reports.reduce((n, r) => n + r.report.skipped, 0), 1, JSON.stringify(reports));
        await h.row.reload(); assert.equal(h.row.status, 'skipped'); assert.equal(h.row.next_check_at, null);
        assert.equal(await models.JobRequest.count(), 1); assert.equal(digest([h.row.change, h.row.evidence, h.row.plan_key]), h.identity);
        assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
      });
      await check(`${provider} ${action}: submitted legacy SQL operations recover only as observations`, async () => {
        for (const applied of [false, true]) {
          await clear(); const h = await historical(true);
          await models.JobRequest.update({ status: 'failed' }, { where: { id: h.queued.jobId } });
          const activation = structuredClone(h.f.setting.activation); activation.optimization.status = 'paused';
          await h.f.setting.update({ activation }); runtime.now = new Date(+h.row.next_check_at + 1);
          assert.equal((await recoverOptimizationRuns(deps)).report.check_queued, 1); await h.row.reload();
          const job = await models.JobRequest.findByPk(h.row.job_request_id); assert.equal(job.type, 'campaign_workspace_optimization_check');
          runtime.remote.get(h.f.change.target.resource).value = applied ? h.f.change.after : h.f.change.before;
          const result = await run(job.id); assert.equal(result.result?.state, applied ? 'observed' : 'uncertain', JSON.stringify(result));
          assert.equal(result.result.provider_mutation, false); await h.row.reload();
          assert.equal(digest([h.row.change, h.row.evidence, h.row.plan_key]), h.identity);
          assert.equal(runtime.reads, 1); assert.equal(runtime.writes, 0);
        }
      });
    }
    for (const action of ['pause_underperforming_ads', 'adjust_bids', 'adjust_budget']) {
      await clear();
      await check(`${provider} ${action}: fresh policy recovery queues once and preserves its original SQL evidence`, async () => {
        const f = action === 'adjust_budget' ? await budgetSeed(provider)
          : await seed(provider, 1, '20', '30', action, action === 'pause_underperforming_ads' ? '60' : '50');
        const proposal = await (action === 'adjust_budget' ? budgetProposal(f) : action === 'adjust_bids' ? bidProposal(f) : pauseProposal(f));
        const queued = await proposal.enqueue();
        const row = await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId);
        const original = digest([row.plan_key, row.change, row.evidence]);
        await models.JobRequest.update({ status: 'failed' }, { where: { id: queued.jobId } });
        runtime.now = new Date(+runtime.now + 60000); await row.update({ next_check_at: new Date(+runtime.now - 1) });
        const results = await Promise.all([recoverOptimizationRuns(deps), recoverOptimizationRuns(deps)]);
        assert.equal(results.reduce((sum, result) => sum + result.report.apply_queued, 0), 1, JSON.stringify(results));
        assert.equal(await models.JobRequest.count(), 2); assert.equal(runtime.reads, 0); assert.equal(runtime.writes, 0);
        await row.reload(); assert.equal(row.submitted_at, null); assert.equal(digest([row.plan_key, row.change, row.evidence]), original);
        assert.notEqual(row.job_request_id, queued.jobId);
        const result = await run(row.job_request_id, proposal.overrides);
        assert.equal(result.result?.state, 'verified', JSON.stringify(result)); assert.equal(runtime.writes, 1);
        await row.reload(); assert.equal(digest([row.plan_key, row.change, row.evidence]), original);
      });
    }

    for (const increase of [false, true]) {
      await clear();
      await check(`${provider}: schema-4 budget ${increase ? 'increase' : 'decrease'} survives SQL deduplication and retains scope accounting`, async () => {
        const f = await budgetSeed(provider); const a = await budgetProposal(f, 'sql-budget-cycle', increase);
        runtime.now = new Date(+runtime.now + 1000); const b = await budgetProposal(f, 'sql-budget-cycle', increase);
        const jobs = await Promise.all([a.enqueue(), b.enqueue()]); assert.equal(jobs[0].runId, jobs[1].runId);
        assert.equal(await models.JobRequest.count(), 1);
        const result = await run(jobs[0].jobId, a.overrides); assert.equal(result.result?.state, 'verified', JSON.stringify(result));
        const receipt = await models.CampaignWorkspaceOptimizationRun.findByPk(jobs[0].runId);
        assert.equal(receipt.evidence.schema_version, 4); assert.ok(receipt.outcome.budget_accounting.fingerprint);
        assert.equal(receipt.outcome.budget_accounting.limit_cents, 500000); assert.equal(runtime.writes, 1);
        assert.equal((await run(jobs[0].jobId, a.overrides)).result.idempotent, true); assert.equal(runtime.writes, 1);
      });
    }
    await clear();
    await check(`${provider}: SQL budget evaluator cannot bypass fourteen-day campaign observation`, async () => {
      const f = await budgetSeed(provider); const a = await budgetProposal(f); const first = await a.enqueue();
      assert.equal((await run(first.jobId, a.overrides)).result.state, 'verified');
      runtime.now = new Date(+runtime.now + 1000); const b = await budgetProposal(f, 'next-cycle'); const second = await b.enqueue();
      const result = await run(second.jobId, b.overrides); assert.equal(result.error_message, 'workspace_optimization_budget_observation_required');
      assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: SQL monthly limit rejects a new budget-policy increase before submission`, async () => {
      const f = await budgetSeed(provider); const activation = structuredClone(f.setting.activation);
      activation.optimization.authorization.limits.monthly_limit_cents = 10000; await f.setting.update({ activation });
      const a = await budgetProposal(f, 'limit-cycle', true); const job = await a.enqueue();
      const result = await run(job.jobId, a.overrides); assert.equal(result.result?.reason, 'workspace_optimization_budget_limit_exceeded', JSON.stringify(result));
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(job.runId); assert.equal(row.submitted_at, null);
      assert.equal(runtime.writes, 0);
    });
    await clear();
    await check(`${provider}: schema-3 bid evidence and cycle deduplication survive concurrent SQL persistence`, async () => {
      const f = await seed(provider); const a = await bidProposal(f);
      runtime.now = new Date(+runtime.now + 1000); const b = await bidProposal(f);
      const jobs = await Promise.all([a.enqueue(), b.enqueue()]);
      assert.equal(jobs[0].runId, jobs[1].runId); assert.equal(await models.JobRequest.count(), 1);
      const result = await run(jobs[0].jobId, a.overrides); assert.equal(result.result?.state, 'verified', JSON.stringify(result));
      assert.equal(runtime.writes, 1); const row = await models.CampaignWorkspaceOptimizationRun.findByPk(jobs[0].runId);
      assert.equal(row.evidence.schema_version, 3); assert.equal(row.evidence.daily.length, 28);
      assert.equal((await run(jobs[0].jobId, a.overrides)).result.idempotent, true); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: another SQL evaluation cannot bypass the campaign observation period`, async () => {
      const f = await seed(provider); const a = await bidProposal(f); const first = await a.enqueue();
      assert.equal((await run(first.jobId, a.overrides)).result?.state, 'verified');
      runtime.now = new Date(+runtime.now + 1000); const b = await bidProposal(f, 'next-cycle'); const second = await b.enqueue();
      assert.notEqual(first.runId, second.runId);
      const result = await run(second.jobId, b.overrides);
      assert.equal(result.error_message, 'workspace_optimization_bid_observation_required'); assert.equal(runtime.writes, 1);
      assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(second.runId)).submitted_at, null);
    });
    await clear();
    await check(`${provider}: schema-2 pause JSON survives SQL round-trip and concurrent cycle deduplication`, async () => {
      const f = await seed(provider, 1, '20', '30', 'pause_underperforming_ads', '60');
      const a = await pauseProposal(f); runtime.now = new Date(+runtime.now + 1000);
      const b = await pauseProposal(f);
      assert.notEqual(a.evidence.observed_at, b.evidence.observed_at);
      const jobs = await Promise.all([a.enqueue(), b.enqueue()]);
      assert.equal(jobs[0].runId, jobs[1].runId); assert.equal(await models.JobRequest.count(), 1);
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(jobs[0].runId);
      assert.equal(row.evidence.schema_version, 2); assert.equal(row.evidence.daily.length, 28);
      const result = await run(jobs[0].jobId, a.overrides);
      assert.equal(result.result?.state, 'verified', JSON.stringify(result)); assert.equal(runtime.writes, 1);
      assert.equal((await run(jobs[0].jobId, a.overrides)).result.idempotent, true); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: SQL group cooldown includes a newly authorized different ad`, async () => {
      const f = await seed(provider, 1, '20', '30', 'pause_underperforming_ads', '60');
      const a = await pauseProposal(f); const first = await a.enqueue();
      assert.equal((await run(first.jobId, a.overrides)).result?.state, 'verified');
      const activation = structuredClone(f.setting.activation);
      activation.optimization.authorization.campaigns[0].targets.push({ ...a.change.target, id: '62',
        resource: provider === 'google_ads' ? 'customers/20/adGroupAds/50~62' : '62' });
      await f.setting.update({ activation, version: f.setting.version + 1 });
      runtime.now = new Date(+runtime.now + 1000);
      const b = await pauseProposal(f, '62'); const second = await b.enqueue();
      assert.notEqual(first.runId, second.runId);
      const result = await run(second.jobId, b.overrides);
      assert.equal(result.error_message, 'workspace_optimization_cooldown'); assert.equal(runtime.writes, 1);
      assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(second.runId)).submitted_at, null);
    });
    await clear();
    await check(`${provider}: SQL pause reservation rolls back when reception disappears`, async () => {
      const f = await seed(provider, 1, '20', '30', 'pause_underperforming_ads', '60');
      const a = await pauseProposal(f); const job = await a.enqueue();
      const result = await run(job.jobId, { ...a.overrides, receptionDependencies: { loadInventory, loadReception: async () => new Map() } });
      assert.equal(result.result?.state, 'skipped'); assert.equal(runtime.writes, 0);
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(job.runId);
      assert.equal(row.submitted_at, null); assert.equal(row.outcome.reason, 'workspace_optimization_reception_unverified');
    });
    await clear();
    await check(`${provider}: persisted JSON and two workers submit exactly once`, async () => {
      const f = await seed(provider); const jobs = await Promise.all([f.enqueue(), f.enqueue()]);
      assert.equal(jobs[0].runId, jobs[1].runId); assert.equal(await models.JobRequest.count(), 1);
      const results = await Promise.all([run(jobs[0].jobId), run(jobs[0].jobId)]);
      assert.equal(runtime.writes, 1, JSON.stringify(results));
      assert.ok(results.some(row => row.result?.state === 'verified'), JSON.stringify(results));
      assert.equal((await run(jobs[0].jobId)).result.idempotent, true); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: first budget receipt remains usable on a later adjustment`, async () => {
      const f = await seed(provider, 1, '20', '30', 'adjust_budget'); const first = await f.enqueue();
      assert.equal((await run(first.jobId)).result?.state, 'verified');
      runtime.now = new Date(+runtime.now + 14 * 86400000);
      const next = optimizationChange({ ...f.change, before: '950', after: '903' });
      const queued = await f.enqueue({ change: next, evidence: await f.proof(next, 'later-budget-cycle') });
      const result = await run(queued.jobId); assert.equal(result.result?.state, 'verified', JSON.stringify(result));
      const receipt = (await models.CampaignWorkspaceOptimizationRun.findByPk(queued.runId)).outcome.budget_accounting;
      assert.equal(receipt.reported_spend_cents, 500); assert.equal(runtime.writes, 2);
    });
    await clear();
    await check(`${provider}: revoked membership during provider inspection prevents submission`, async () => {
      const f = await seed(provider); const job = await f.enqueue(); const entered = barrier(); const release = barrier();
      const running = run(job.jobId, { inspect: async () => { entered.release(); await release.promise; } });
      await Promise.race([entered.promise, running.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
      try { await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_usuario: 901 } }); }
      finally { release.release(); }
      const result = await running; assert.equal(result.result?.state, 'skipped', JSON.stringify(result));
      assert.equal(runtime.writes, 0); assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(job.runId)).submitted_at, null);
    });
    await clear();
    await check(`${provider}: different workspaces sharing an account cannot inspect concurrently`, async () => {
      const a = await seed(provider); const b = await seed(provider, 2, '20', '31', 'adjust_bids', '51');
      const one = await a.enqueue(); const two = await b.enqueue();
      const entered = barrier(); const release = barrier();
      const first = run(one.jobId, { inspect: async () => { entered.release(); await release.promise; } });
      await Promise.race([entered.promise, first.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
      try { const second = await run(two.jobId); assert.equal(second.error_message, 'workspace_optimization_account_busy', JSON.stringify(second)); }
      finally { release.release(); }
      assert.equal((await first).result?.state, 'verified'); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: concurrent recovery produces only one read-only job`, async () => {
      const f = await seed(provider); const first = await f.enqueue();
      const result = await run(first.jobId, { mutate: async () => { runtime.writes++; throw Error('simulated timeout'); } });
      assert.equal(result.result?.state, 'uncertain');
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(first.runId); runtime.now = new Date(+row.next_check_at + 1000);
      const results = await Promise.all([recoverOptimizationRuns(deps), recoverOptimizationRuns(deps)]);
      assert.equal(results.reduce((sum, result) => sum + result.report.check_queued, 0), 1, JSON.stringify(results));
      const checks = await models.JobRequest.findAll({ where: { type: 'campaign_workspace_optimization_check' } }); assert.equal(checks.length, 1);
      runtime.remote.get(f.change.target.resource).value = f.change.after;
      assert.equal((await run(checks[0].id)).result?.state, 'observed'); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: a lost acknowledgement after a real commit preserves submission and budget`, async () => {
      const f = await seed(provider, 1, '20', '30', 'adjust_budget'); const first = await f.enqueue();
      const transaction = sql.transaction.bind(sql); let lost = false;
      sql.transaction = async (...args) => {
        const value = await transaction(...args);
        if (!lost && (await models.CampaignWorkspaceOptimizationRun.findByPk(first.runId)).status === 'submitted') {
          lost = true; throw Error('simulated lost commit acknowledgement');
        }
        return value;
      };
      let result;
      try { result = await run(first.jobId); } finally { sql.transaction = transaction; }
      assert.equal(result.result?.state, 'uncertain', JSON.stringify(result)); assert.ok(lost);
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(first.runId);
      assert.ok(row.submitted_at); assert.ok(row.outcome.budget_accounting); assert.equal(runtime.writes, 0);
      await run(first.jobId); assert.equal(runtime.writes, 0);
    });
    await clear();
    await check(`${provider}: a receipt transaction rollback cannot replay an already submitted change`, async () => {
      const f = await seed(provider, 1, '20', '30', 'adjust_budget'); const first = await f.enqueue();
      const transaction = sql.transaction.bind(sql); let failed = false;
      sql.transaction = callback => transaction(async tx => {
        const value = await callback(tx);
        if (!failed && value?.result?.state === 'verified') { failed = true; throw Error('simulated receipt rollback'); }
        return value;
      });
      let result;
      try { result = await run(first.jobId); } finally { sql.transaction = transaction; }
      assert.equal(result.result?.state, 'uncertain', JSON.stringify(result)); assert.ok(failed);
      const row = await models.CampaignWorkspaceOptimizationRun.findByPk(first.runId);
      assert.ok(row.submitted_at); assert.ok(row.outcome.budget_accounting); assert.equal(runtime.writes, 1);
      assert.equal((await run(first.jobId)).result?.state, 'observed'); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: an expired worker cannot replace the new worker's receipt`, async () => {
      const f = await seed(provider); const first = await f.enqueue(); const entered = barrier(); const release = barrier();
      const old = run(first.jobId, { inspect: async () => { entered.release(); await release.promise; } });
      await Promise.race([entered.promise, old.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
      try {
        runtime.now = new Date(+runtime.now + LEASE_MS + 1000);
        assert.equal((await run(first.jobId)).result?.state, 'verified');
      } finally { release.release(); }
      const result = await old; assert.equal(result.status, 'failed');
      assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(first.runId)).status, 'verified'); assert.equal(runtime.writes, 1);
    });
    await clear();
    await check(`${provider}: pausing the mandate through the real command stops an in-flight preflight`, async () => {
      const f = await seed(provider); const first = await f.enqueue(); const entered = barrier(); const release = barrier();
      const running = run(first.jobId, { inspect: async () => { entered.release(); await release.promise; } });
      await Promise.race([entered.promise, running.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
      try { await pauseWorkspaceOptimization({ models, scope: { groupId: null, clinicIds: [1] }, actorId: 901,
        input: { confirmed: true, expected_version: f.setting.version }, hasAccess, now: () => runtime.now }); }
      finally { release.release(); }
      const result = await running; assert.equal(result.result?.state, 'skipped', JSON.stringify(result)); assert.equal(runtime.writes, 0);
    });
    await clear();
    await check(`${provider}: a clinic exclusion stops its group mandate after provider preflight`, async () => {
      const f = await seed(provider);
      await models.Clinica.update({ grupoClinicaId: 10 }, { where: { id_clinica: 1 } });
      await f.setting.update({ scope_type: 'group', scope_id: 10 });
      const local = await models.CampaignWorkspaceSetting.create({ id: crypto.randomUUID(), scope_type: 'clinic', scope_id: 1,
        version: 1, updated_by_user_id: 901, accounts: f.setting.accounts });
      const first = await f.enqueue({ evidence: await f.proof() }); const entered = barrier(); const release = barrier();
      const running = run(first.jobId, { inspect: async () => { entered.release(); await release.promise; } });
      await Promise.race([entered.promise, running.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
      try { await local.update({ accounts: [], version: 2 }); }
      finally { release.release(); }
      const result = await running;
      assert.equal(result.result?.reason, 'workspace_optimization_campaign_not_authorized', JSON.stringify(result));
      assert.equal(result.result?.state, 'skipped'); assert.equal(runtime.writes, 0);
      assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(first.runId)).submitted_at, null);
      await assert.rejects(f.enqueue(), /workspace_optimization_campaign_not_authorized/);
    });
  }
  await clear();
  await check('producer and job insertion roll back together in MySQL', async () => {
    const f = await seed('google_ads');
    await assert.rejects(enqueueOptimizationAdjustment({ settingId: f.setting.id, mandateId: f.setting.activation.optimization.id,
      change: f.change, evidence: f.evidence }, { ...deps, enqueue: async (...args) => { await enqueue(...args); throw Error('job transaction failed'); } }), /job transaction/);
    assert.equal(await models.JobRequest.count(), 0); assert.equal(await models.CampaignWorkspaceOptimizationRun.count(), 0);
  });
  await clear();
  await check('independent accounts can inspect concurrently without a workspace-wide global mutex', async () => {
    const a = await seed('google_ads'); const b = await seed('meta_ads', 2, '21', '31', 'adjust_bids', '51');
    const one = await a.enqueue(); const two = await b.enqueue(); const entered = barrier(); const release = barrier();
    const first = run(one.jobId, { inspect: async () => { entered.release(); await release.promise; } });
    await Promise.race([entered.promise, first.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
    try { const second = await run(two.jobId); assert.equal(second.result?.state, 'verified', JSON.stringify(second)); }
    finally { release.release(); }
    assert.equal((await first).result?.state, 'verified'); assert.equal(runtime.writes, 2);
  });
  await clear();
  await check('one monthly limit covers concurrent commands for two different selected accounts', async () => {
    const a = await seed('meta_ads', 1, '20', '30', 'adjust_budget', '50');
    const b = await seed('meta_ads', 1, '21', '31', 'adjust_budget', '51', true);
    const activation = structuredClone(b.setting.activation); activation.optimization.authorization.limits.monthly_limit_cents = 42500;
    await b.setting.update({ activation });
    const firstChange = optimizationChange({ ...a.change, after: '1050' });
    const secondChange = optimizationChange({ ...b.change, after: '1050' });
    const one = await a.enqueue({ change: firstChange, evidence: await a.proof(firstChange, 'first-increase', 'increase') });
    const two = await b.enqueue({ change: secondChange, evidence: await b.proof(secondChange, 'second-increase', 'increase') });
    const entered = barrier(); const release = barrier();
    const first = run(one.jobId, { inspect: async () => { entered.release(); await release.promise; } });
    await Promise.race([entered.promise, first.then(result => { throw Error('Inspection not reached: ' + JSON.stringify(result)); })]);
    try { assert.equal((await run(two.jobId)).error_message, 'workspace_optimization_account_busy'); }
    finally { release.release(); }
    assert.equal((await first).result?.state, 'verified');
    const result = await run(two.jobId); assert.equal(result.result?.reason, 'workspace_optimization_budget_limit_exceeded', JSON.stringify(result));
    assert.equal((await models.CampaignWorkspaceOptimizationRun.findByPk(two.runId)).submitted_at, null); assert.equal(runtime.writes, 1);
  });
  report.connectionCount = runtime.connections.size;
  assert.ok(runtime.connections.size >= 2, 'Concurrency must use independent MySQL connections');
  await assert.rejects(migration.down(sql.getQueryInterface()), /explicit archival/);
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
