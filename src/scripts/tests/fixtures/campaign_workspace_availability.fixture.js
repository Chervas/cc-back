'use strict';

if (require.main === module) {
  require('./campaign_offline_runtime.cjs');
  const modelFile = require.resolve('../../../../models');
  if (require.cache[modelFile]) throw Error('The offline fixture must run before the production model index is loaded');
  require.cache[modelFile] = { id: modelFile, filename: modelFile, loaded: true, exports: {} };
}

const { ACTIONS, digest } = require('../../../services/campaignWorkspaceOptimizationCapabilities.service');
const { publicOptimizationProof } = require('../../../services/campaignWorkspaceOptimizationPreparation.service');
const { loadOptimizationAuthorizationReview } = require('../../../services/campaignWorkspaceOptimizationAuthorization.service');

function availabilityFixture(kind) {
  const now = new Date('2026-09-11T12:00:00Z');
  const provider = kind === 'google_negative' ? 'google_ads' : 'meta_ads';
  const reference = { provider, account_id: '20', campaign_id: '30' };
  const scope = { clinicIds: [901], groupId: null };
  const campaign = { ...reference, id: `${provider}:20:30`, name: 'Primera visita', clinicId: 901, assigned: true, paused: false };
  const setting = { id: '11111111-1111-4111-8111-111111111111', version: 2, scope_type: 'clinic', scope_id: 901,
    accounts: [{ provider, account_id: '20', include_future: true, campaign_ids: [] }],
    preferences: { mode: 'optimize', signals: { enabled: false, events: [] }, optimization: {
      actions: provider === 'google_ads' ? ['negative_keywords'] : ['pause_underperforming_ads', 'adjust_bids'],
      budget_changes: true, max_budget_change_pct: 10, monthly_limit_cents: 150000 } }, activation: null };
  const targets = provider === 'google_ads' ? [{ action: 'negative_keywords', entity: 'campaign', id: '30',
    resource: 'customers/20/campaigns/30', field: 'keyword', match_type: 'EXACT' }] : [{ action: 'adjust_bids', entity: 'ad_set',
    id: '50', resource: '50', field: 'bid_amount', unit: 'minor', strategy: 'COST_CAP', value: '1000' }];
  if (kind === 'meta_mixed') targets.push({ ...targets[0], id: '51', resource: '51', strategy: 'LOWEST_COST_WITH_BID_CAP' },
    { action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '51', resource: '60', field: 'status', value: 'ACTIVE' },
    { action: 'pause_underperforming_ads', entity: 'ad', id: '61', group_id: '51', resource: '61', field: 'status', value: 'ACTIVE' });
  const inspection = { schema_version: 1, reference, currency: 'EUR', targets, actions: ACTIONS.map(action => ({ action,
    targets: targets.filter(target => target.action === action).length, reasons: [] })) };
  inspection.fingerprint = digest([reference, inspection.currency, targets, inspection.actions]);
  const context = { setting, reference, campaign, fingerprint: 'a'.repeat(64),
    grant: { fingerprint: 'b'.repeat(64), connection: { id: 1 }, loginCustomerId: null }, latest: {
      schema_version: 1, fingerprint: 'a'.repeat(64), run_id: '22222222-2222-4222-8222-222222222222', status: 'checked',
      checked_at: now.toISOString(), expires_at: new Date(+now + 86400000).toISOString(), error: null, inspection,
    } };
  return { now, scope, setting, campaign, context };
}

async function availabilityResponses() {
  const results = {};
  for (const kind of ['meta_pending', 'meta_mixed', 'google_negative']) {
    const f = availabilityFixture(kind);
    const result = await loadOptimizationAuthorizationReview({ models: {}, scope: f.scope, setting: f.setting,
      campaigns: [f.campaign], now: f.now, resolveContext: async () => f.context });
    results[kind] = { review: result.review, preparation: publicOptimizationProof(f.context, f.now) };
  }
  return results;
}

if (require.main === module) availabilityResponses().then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.exitCode = 1; });
module.exports = { availabilityFixture, availabilityResponses };
