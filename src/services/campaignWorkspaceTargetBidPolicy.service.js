'use strict';

const { digest } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { optimizationChange } = require('./campaignWorkspaceOptimizationCommand.service');
const { verifyTargetSnapshot, scaled, ratio, inspectGoogleTargetSnapshot } = require('./campaignWorkspaceGoogleTargetSnapshot.service');

const POLICY = Object.freeze({ version: 1, max_change_percent: 10, cooldown_hours: 336, evidence_ttl_ms: 900000 });
const fail = () => { throw Object.assign(new Error('workspace_optimization_evidence_invalid'), { code: 'workspace_optimization_evidence_invalid' }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');

function recommendedChange(snapshot) {
  verifyTargetSnapshot(snapshot);
  const cpa = snapshot.target.unit === 'micros'; const type = cpa ? 'RAISE_TARGET_CPA' : 'LOWER_TARGET_ROAS';
  const matches = snapshot.recommendations.filter(rec => rec.type === type); if (matches.length !== 1) return null;
  const recommendation = matches[0];
  const before = cpa ? BigInt(snapshot.before) : scaled(snapshot.before);
  if (before !== BigInt(recommendation.average_target_micros)) return null;
  const [whole, fraction = ''] = recommendation.multiplier.split('.');
  const denominator = 10n ** BigInt(fraction.length); const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  const delta = numerator > denominator ? numerator - denominator : denominator - numerator;
  if (!delta || (cpa ? numerator <= denominator : numerator >= denominator)
    || delta * 100n > denominator * BigInt(POLICY.max_change_percent)) return null;
  // Keep the provider multiplier, rounding only sub-micro precision towards the unchanged target.
  const result = cpa ? before * numerator / denominator : (before * numerator + denominator - 1n) / denominator;
  if (!result || result === before) return null;
  const after = cpa ? String(result) : ratio(`${result / 1000000n}.${String(result % 1000000n).padStart(6, '0')}`);
  return optimizationChange({ reference: snapshot.reference, target: snapshot.target, before: snapshot.before, after });
}

function validateTargetBidEvidence(evidence, now, change) {
  if (!keys(evidence, ['schema_version', 'rule', 'policy_version', 'setting_id', 'mandate_id', 'clinic_id', 'source_fingerprint',
    'collection_fingerprint', 'evaluation_key', 'observed_at', 'snapshot']) || evidence.schema_version !== 5
    || evidence.rule !== 'google_target_recommendation' || evidence.policy_version !== POLICY.version
    || !uuid(evidence.setting_id) || !uuid(evidence.mandate_id) || !Number.isSafeInteger(evidence.clinic_id) || evidence.clinic_id <= 0
    || !['source_fingerprint', 'collection_fingerprint', 'evaluation_key'].every(key => hash(evidence[key]))
    || !Number.isFinite(+now) || !instant(evidence.observed_at) || +new Date(evidence.observed_at) > +now
    || +now - +new Date(evidence.observed_at) >= POLICY.evidence_ttl_ms) fail();
  verifyTargetSnapshot(evidence.snapshot);
  const gap = +new Date(evidence.observed_at) - +new Date(evidence.snapshot.observed_at);
  if (gap < 0 || gap >= 60000 || !change || digest(recommendedChange(evidence.snapshot)) !== digest(change)) fail();
  return structuredClone(evidence);
}

function buildTargetBidProposals(collection, { evaluationKey, now = new Date() }) {
  if (!keys(collection, ['schema_version', 'setting_id', 'mandate_id', 'clinic_id', 'reference', 'action', 'source_fingerprint',
    'target_snapshot', 'reception', 'authorization_targets', 'collected_at', 'observed_at', 'fingerprint']) || collection.schema_version !== 3
    || collection.action !== 'adjust_bids' || !hash(evaluationKey) || !hash(collection.fingerprint)) fail();
  const { fingerprint, ...body } = collection;
  if (!Number.isFinite(+now) || digest(body) !== fingerprint || !instant(collection.collected_at) || !instant(collection.observed_at)
    || +new Date(collection.observed_at) > +now || +new Date(collection.collected_at) > +new Date(collection.observed_at)
    || +now - +new Date(collection.collected_at) >= 60000) fail();
  const snapshot = verifyTargetSnapshot(collection.target_snapshot);
  if (digest(snapshot.reference) !== digest(collection.reference) || !Array.isArray(collection.authorization_targets)
    || +new Date(snapshot.observed_at) < +new Date(collection.collected_at)
    || collection.authorization_targets.filter(target => digest(target) === digest(snapshot.target)).length !== 1) fail();
  if (collection.reception?.checked !== true || collection.reception.ready !== true || collection.reception.state !== 'verified') return [];
  const change = recommendedChange(snapshot); if (!change) return [];
  const evidence = { schema_version: 5, rule: 'google_target_recommendation', policy_version: POLICY.version,
    setting_id: collection.setting_id, mandate_id: collection.mandate_id, clinic_id: collection.clinic_id,
    source_fingerprint: collection.source_fingerprint, collection_fingerprint: fingerprint, evaluation_key: evaluationKey,
    observed_at: collection.observed_at, snapshot };
  validateTargetBidEvidence(evidence, now, change); return [{ change, evidence }];
}

async function assertTargetBidBaseline({ evidence, change, credentials, now = () => new Date(), read, clock }) {
  if (evidence.schema_version !== 5) return;
  validateTargetBidEvidence(evidence, now(), change);
  const current = await inspectGoogleTargetSnapshot({ reference: change.reference, ...credentials, now, read, clock });
  const stable = snapshot => { const { fingerprint, observed_at, ...body } = snapshot; return digest(body); };
  if (stable(current) !== stable(evidence.snapshot)) throw Object.assign(new Error('workspace_optimization_target_changed'), { code: 'workspace_optimization_target_changed' });
  validateTargetBidEvidence(evidence, now(), change);
}

module.exports = { POLICY, recommendedChange, validateTargetBidEvidence, buildTargetBidProposals, assertTargetBidBaseline };
