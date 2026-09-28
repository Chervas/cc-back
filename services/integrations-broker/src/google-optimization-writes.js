'use strict';
const C = require('./google-optimization-write-contract');
const ads = require('./google-ads-contract');
const targets = require('./google-optimization-targets-contract');
const { fail } = require('./errors');

async function inspect(context, account, developerToken, check) {
  const input = context.payload;
  const read = async (section, family = 'optimization') => {
    const payload = { campaignId: input.campaignId, section, pageToken: null };
    const query = section === 'campaign' ? targets.query(payload, account) : ads.query(family, payload, account);
    const rows = [], seen = new Set(), tokens = new Set(); let pageToken;
    do {
      check();
      const raw = await context.http({ hostname: 'googleads.googleapis.com', path: `/v24/customers/${account.customerId}/googleAds:search`,
        token: context.secret, developerToken, loginCustomerId: account.loginCustomerId, signal: context.signal,
        json: { query, ...(pageToken ? { pageToken } : {}) } });
      check(); const page = ads.projectPage(family, raw, payload, account);
      if (section === 'campaign') {
        if (page.results.length !== 1 || raw.results[0].customer.timeZone !== 'Europe/Madrid') fail('optimization_conflict');
        page.results[0].customer.timeZone = raw.results[0].customer.timeZone;
      }
      for (const row of page.results) {
        const key = ads.rowKey(row); if (seen.has(key)) fail('provider_failed'); seen.add(key); rows.push(row);
      }
      pageToken = page.nextPageToken;
      if (rows.length > 2000 || pageToken && (!page.results.length || tokens.has(pageToken) || tokens.size >= 2000)) fail('provider_failed');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    return rows;
  };
  const metadata = await read('campaign'); const { customer, campaign, campaignBudget: budget } = metadata[0] || {};
  if (metadata.length !== 1 || customer.currencyCode !== 'EUR' || campaign.status !== 'ENABLED' || campaign.experimentType !== 'BASE'
    || !['SEARCH', 'PERFORMANCE_MAX'].includes(campaign.advertisingChannelType)) fail('optimization_conflict');
  const equal = value => { if (C.scaled(String(value), C.ratioKind(input.kind)) !== C.scaled(input.before, C.ratioKind(input.kind))) fail('optimization_conflict'); };
  const exclusiveBudget = () => {
    if (!budget || typeof budget.resourceName !== 'string' || budget.period !== 'DAILY' || budget.explicitlyShared === true || budget.referenceCount !== '1') fail('optimization_conflict');
    C.scaled(budget.amountMicros);
  };
  if (input.kind === 'daily_budget') {
    exclusiveBudget(); if (budget.resourceName !== C.mutation(input, account.customerId).resourceName) fail('optimization_conflict'); equal(budget.amountMicros);
  } else if (input.kind === 'pause_ad') {
    if (campaign.advertisingChannelType !== 'SEARCH') fail('optimization_conflict');
    const rows = await read('ads');
    const eligible = rows.filter(row => row.adGroup.id === input.adGroupId && row.adGroup.status === 'ENABLED'
      && row.adGroupAd.status === 'ENABLED' && row.adGroupAd.primaryStatus === 'ELIGIBLE' && row.adGroupAd.policySummary.approvalStatus === 'APPROVED');
    if (!eligible.some(row => row.adGroupAd.ad.id === input.resourceId) || !eligible.some(row => row.adGroupAd.ad.id === input.baselineAdId)) fail('optimization_conflict');
  } else {
    if (campaign.biddingStrategy) fail('optimization_conflict');
    if (input.kind === 'manual_cpc') {
      if (campaign.advertisingChannelType !== 'SEARCH' || campaign.biddingStrategyType !== 'MANUAL_CPC') fail('optimization_conflict');
      const matches = (await read('ad_groups')).filter(row => row.adGroup.id === input.resourceId && row.adGroup.status === 'ENABLED');
      if (matches.length !== 1) fail('optimization_conflict'); equal(matches[0].adGroup.cpcBidMicros);
    } else {
      exclusiveBudget();
      const schemes = { target_cpa: ['TARGET_CPA', 'targetCpa', 'targetCpaMicros'], maximize_conversions_cpa: ['MAXIMIZE_CONVERSIONS', 'maximizeConversions', 'targetCpaMicros'],
        target_roas: ['TARGET_ROAS', 'targetRoas', 'targetRoas'], maximize_conversion_value_roas: ['MAXIMIZE_CONVERSION_VALUE', 'maximizeConversionValue', 'targetRoas'] };
      const [strategy, key, field] = schemes[input.kind];
      if (campaign.biddingStrategyType !== strategy) fail('optimization_conflict'); equal(campaign[key]?.[field]);
      if (campaign.advertisingChannelType === 'SEARCH' && (await read('ad_groups', 'optimization_targets')).some(row =>
        ![undefined, '0'].includes(row.adGroup.targetCpaMicros) || ![undefined, 0].includes(row.adGroup.targetRoas))) fail('optimization_conflict');
    }
  }
  if (C.hash(await read('campaign')) !== C.hash(metadata)) fail('optimization_conflict');
}

function createGoogleOptimizationWrites({ store, http, withDeveloperSecret, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_optimization_mutations (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL, asset TEXT NOT NULL,
    input_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('attempted','applied')),
    request_id TEXT NOT NULL, campaign_key TEXT NOT NULL, cooldown_key TEXT NOT NULL, created_at INTEGER NOT NULL, result_json TEXT);
    CREATE TABLE IF NOT EXISTS google_optimization_locks (
      resource TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES google_optimization_mutations(id));
    CREATE TABLE IF NOT EXISTS google_optimization_reviews (
      execution_id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL, asset TEXT NOT NULL,
      input_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, result_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS google_optimization_cooldown ON google_optimization_mutations(cooldown_key,created_at);`);
  const load = (request, principal, binding, kind) => {
    const row = store.db.prepare('SELECT * FROM google_optimization_mutations WHERE id=?').get(request.payload.executionId);
    if (!row) return null;
    if (row.principal !== principal.id || row.tenant !== request.tenantRef || row.connection !== request.connectionRef
      || row.asset !== request.assetRef || row.scope_digest !== C.scopeDigest(binding, C.resource(binding, request.assetRef), principal)) fail('scope_denied');
    if (kind === 'apply' && row.input_digest !== C.hash(request.payload)) fail('idempotency_conflict');
    return row;
  };
  const receipt = row => row.state === 'applied' ? JSON.parse(row.result_json)
    : { executionId: row.id, state: 'unknown', result: null };
  const reviewed = (request, principal, binding, comparePayload = false) => {
    const row = store.db.prepare('SELECT * FROM google_optimization_reviews WHERE execution_id=?').get(request.payload.executionId);
    if (!row) return null;
    if (row.principal !== principal.id || row.tenant !== request.tenantRef || row.connection !== request.connectionRef
      || row.asset !== request.assetRef || row.scope_digest !== C.scopeDigest(binding, C.resource(binding, request.assetRef), principal)) fail('scope_denied');
    if (comparePayload && row.input_digest !== C.hash(request.payload)) fail('idempotency_conflict');
    return JSON.parse(row.result_json);
  };
  const requireApplyGrant = (request, principal, policy) => {
    if (!policy.grants.some(grant => grant.principalId === principal.id && grant.tenantRef === request.tenantRef
      && grant.connectionRef === request.connectionRef && grant.assetRef === request.assetRef
      && grant.operations.includes(C.OPERATIONS.apply))) fail('scope_denied');
  };
  const operations = Object.fromEntries(['apply', 'status'].map(kind => [C.OPERATIONS[kind], {
    provider: ads.PROVIDER, requiredScopes: ads.SCOPES, effect: kind === 'apply' ? 'write' : 'read',
    ...(kind === 'status' ? { secretless: true, persistResult: false } : {}),
    validate: payload => C.validate(kind, payload),
    authorize({ request, binding, principal, policy }) {
      requireApplyGrant(request, principal, policy);
      C.resource(binding, request.assetRef, kind === 'apply' ? request.payload : null); load(request, principal, binding, kind);
      if (reviewed(request, principal, binding, kind === 'apply') && kind === 'apply') fail('optimization_reviewed');
    },
    async execute(context) {
      const { binding, assetRef, tenantRef, principalId, payload, assertActive } = context;
      const principal = context.policy.principals.find(row => row.id === principalId);
      const request = { payload, assetRef, tenantRef, connectionRef: binding.connectionRef };
      const existing = load(request, principal, binding, kind); assertActive();
      if (kind === 'status') {
        if (!context.policy.grants.some(grant => grant.principalId === principalId && grant.tenantRef === tenantRef
          && grant.connectionRef === binding.connectionRef && grant.assetRef === assetRef && grant.operations.includes(C.OPERATIONS.apply))) fail('scope_denied');
        return reviewed(request, principal, binding) || (existing ? receipt(existing) : { executionId: payload.executionId, state: 'not_found', result: null });
      }
      if (existing) { if (existing.state !== 'applied') fail('outcome_unknown'); return receipt(existing); }
      const account = C.resource(binding, assetRef, payload); const started = now();
      const check = () => {
        assertActive(); const at = now();
        if (!Number.isFinite(at) || at < started || at >= payload.expiresAt || payload.expiresAt - at > C.TTL_MS) fail('optimization_expired');
        if (reviewed(request, principal, binding, true)) fail('optimization_reviewed');
      };
      check();
      return withDeveloperSecret(binding, async developerToken => {
        await inspect({ ...context, http }, account, developerToken, check);
        const campaignKey = `${account.customerId}:${payload.campaignId}`;
        const cooldownKey = `${campaignKey}:${C.action(payload.kind)}${payload.kind === 'pause_ad' ? ':' + payload.adGroupId : ''}`;
        const cooldownMs = (payload.kind === 'pause_ad' ? 24 : 336) * 3600000;
        store.transaction(() => {
          check(); if (load(request, principal, binding, kind)) fail('outcome_unknown');
          if (store.db.prepare('SELECT 1 FROM google_optimization_locks WHERE resource=?').get(campaignKey)) fail('optimization_busy');
          if (store.db.prepare('SELECT 1 FROM google_optimization_mutations WHERE cooldown_key=? AND created_at>?').get(cooldownKey, now() - cooldownMs)) fail('optimization_cooldown');
          // This durable marker survives HTTP timeouts, audit failures and process
          // exits. A new transport UUID cannot repeat an uncertain execution.
          store.db.prepare("INSERT INTO google_optimization_mutations VALUES (?,?,?,?,?,?,?,'attempted',?,?,?,?,NULL)")
            .run(payload.executionId, principalId, tenantRef, binding.connectionRef, assetRef, C.hash(payload),
              C.scopeDigest(binding, account, principal), context.requestId, campaignKey, cooldownKey, now());
          store.db.prepare('INSERT INTO google_optimization_locks VALUES (?,?)').run(campaignKey, payload.executionId);
        });
        check(); const mutation = C.mutation(payload, account.customerId);
        const raw = await http({ hostname: 'googleads.googleapis.com', path: mutation.path, json: mutation.body,
          optimizationMutation: payload.kind, token: context.secret, developerToken, loginCustomerId: account.loginCustomerId, signal: context.signal });
        assertActive();
        return { executionId: payload.executionId, state: 'applied', result: C.result(raw, mutation.resourceName) };
      }, { signal: context.signal });
    },
    project(result) {
      if (!result || Buffer.byteLength(JSON.stringify(result)) > 4096) fail('provider_failed'); return structuredClone(result);
    },
    commit({ request, principal, result }) {
      if (kind !== 'apply') return;
      if (store.db.prepare('SELECT 1 FROM google_optimization_reviews WHERE execution_id=?').get(request.payload.executionId)) fail('optimization_reviewed');
      const row = store.db.prepare('SELECT * FROM google_optimization_mutations WHERE id=?').get(request.payload.executionId);
      if (!row || row.principal !== principal.id || row.input_digest !== C.hash(request.payload)) fail('outcome_unknown');
      if (row.state === 'applied') return;
      store.db.prepare("UPDATE google_optimization_mutations SET state='applied',result_json=? WHERE id=? AND state='attempted'")
        .run(JSON.stringify(result.data), row.id);
      store.db.prepare('DELETE FROM google_optimization_locks WHERE execution_id=?').run(row.id);
    },
    completionAudit: () => ['integration.completed', 'success', kind === 'apply' ? 'optimization_provider_acknowledged' : 'optimization_receipt_checked'],
  }]));
  const reviewRequest = request => ({ ...request, payload: request.payload.submission });
  const reviewTime = (payload, at) => {
    if (!Number.isFinite(at) || !Number.isSafeInteger(payload.submission.expiresAt + C.REVIEW_DELAY_MS)
      || at < payload.submission.expiresAt + C.REVIEW_DELAY_MS || payload.observedAt < payload.submission.expiresAt + C.REVIEW_DELAY_MS
      || payload.observedAt > at || at - payload.observedAt >= C.TTL_MS) fail('optimization_review_pending');
  };
  const reviewState = (request, principal, binding) => {
    const original = reviewRequest(request); const row = load(original, principal, binding, 'apply');
    const previous = reviewed(original, principal, binding, true);
    return { original, row, previous };
  };
  const settledAttempt = row => {
    if (!row) return;
    const command = store.db.prepare('SELECT state FROM commands WHERE principal=? AND id=?').get(row.principal, row.request_id);
    if (!command || !['unknown', 'completed'].includes(command.state)) fail('optimization_review_pending');
  };
  operations[C.OPERATIONS.review] = {
    provider: ads.PROVIDER, requiredScopes: ads.SCOPES, effect: 'write', secretless: true,
    validate: payload => C.validate('review', payload),
    authorize({ request, binding, principal, policy }) {
      requireApplyGrant(request, principal, policy);
      C.resource(binding, request.assetRef, request.payload.submission); reviewState(request, principal, binding);
    },
    async execute({ payload, principalId, policy, binding, assetRef, tenantRef, assertActive }) {
      assertActive();
      const principal = policy.principals.find(row => row.id === principalId);
      const request = { payload, assetRef, tenantRef, connectionRef: binding.connectionRef };
      if (!policy.grants.some(grant => grant.principalId === principalId && grant.tenantRef === tenantRef
        && grant.connectionRef === binding.connectionRef && grant.assetRef === assetRef && grant.operations.includes(C.OPERATIONS.apply))) fail('scope_denied');
      const { row, previous } = reviewState(request, principal, binding);
      if (previous) return previous;
      settledAttempt(row);
      reviewTime(payload, now());
      return { executionId: payload.submission.executionId, state: 'reviewed', result: {
        reviewedAt: now(), reviewedBy: payload.actorId, observedAt: payload.observedAt, value: payload.value,
        resourceName: C.mutation(payload.submission, C.resource(binding, assetRef).customerId).resourceName,
        previousState: row ? row.state === 'applied' ? 'applied' : 'unknown' : 'not_found',
      } };
    },
    project: result => structuredClone(result),
    commit({ request, principal, policy, result }) {
      const binding = policy.connections.find(row => row.connectionRef === request.connectionRef);
      const { row, previous } = reviewState(request, principal, binding);
      if (previous) { if (C.hash(previous) !== C.hash(result.data)) fail('idempotency_conflict'); return; }
      settledAttempt(row);
      reviewTime(request.payload, now());
      if (now() < result.data.result.reviewedAt) fail('optimization_review_pending');
      const state = row ? row.state === 'applied' ? 'applied' : 'unknown' : 'not_found';
      if (result.data.result.previousState !== state) fail('optimization_conflict');
      store.db.prepare('INSERT INTO google_optimization_reviews VALUES (?,?,?,?,?,?,?,?)').run(request.payload.submission.executionId,
        principal.id, request.tenantRef, request.connectionRef, request.assetRef, C.hash(request.payload.submission),
        C.scopeDigest(binding, C.resource(binding, request.assetRef), principal), JSON.stringify(result.data));
      store.db.prepare('DELETE FROM google_optimization_locks WHERE execution_id=?').run(request.payload.submission.executionId);
    },
    completionAudit: () => ['integration.completed', 'success', 'optimization_manually_reviewed'],
  };
  return { operations };
}
module.exports = { createGoogleOptimizationWrites };
