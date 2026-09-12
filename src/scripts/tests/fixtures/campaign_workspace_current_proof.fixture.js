'use strict';

const { digest } = require('../../../services/campaignWorkspaceOptimizationCapabilities.service');
const { sourceStamp } = require('../../../services/campaignWorkspaceOptimizationEvidence.service');
const { performancePeriod } = require('../../../services/campaignWorkspacePerformanceSnapshot.service');

// Synthetic, complete policy evidence for executor tests, not a production evidence producer.
function currentProof({ setting, scope, source, change, now, cycle = 'executor-test', direction = 'decrease' }) {
  const budget = change.target.action === 'adjust_budget'; const period = performancePeriod(now);
  return { schema_version: budget ? 4 : 3, rule: budget ? 'budget_efficiency' : 'bid_efficiency', policy_version: 1,
    setting_id: setting.id, mandate_id: setting.activation.optimization.id, clinic_id: source.entry.clinic_id,
    reference: change.reference, source_fingerprint: sourceStamp(setting, scope, source),
    collection_fingerprint: digest(['synthetic-collection', change]), evaluation_key: digest(cycle),
    observed_at: now.toISOString(), window_start: period.start, window_end: period.end,
    target_fingerprint: digest(change.target), before: change.before, after: change.after,
    ...(budget ? { direction } : { group_id: change.target.id }),
    daily: Array.from({ length: 28 }, (_, index) => ({
      date: new Date(Date.parse(`${period.start}T12:00:00Z`) + index * 86400000).toISOString().slice(0, 10),
      clicks: 10, leads: 2, cost_micros: budget && direction === 'increase'
        ? String(BigInt(change.before) * (change.target.unit === 'minor' ? 10000n : 1n) * (index < 14 ? 2n : 1n))
        : index < 14 ? '10000000' : '30000000',
    })) };
}

module.exports = { currentProof };
