'use strict';

const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { optimizationChange } = require('./campaignWorkspaceOptimizationCommand.service');
const { performancePeriod } = require('./campaignWorkspacePerformanceSnapshot.service');
const { validateOptimizationCollection } = require('./campaignWorkspaceOptimizationEvidenceValidation.service');

const POLICY = Object.freeze({ version: 1, days_per_window: 14, minimum_leads: 20, minimum_clicks: 100,
  increase_percent: 50, reduction_percent: 5, cooldown_hours: 14 * 24, evidence_ttl_ms: 15 * 60000 });
const ACTION = 'adjust_bids';
const fail = () => { throw Object.assign(new Error('workspace_optimization_evidence_invalid'), { code: 'workspace_optimization_evidence_invalid' }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dayAt = (start, index) => new Date(Date.parse(`${start}T12:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
const micros = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,21})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER) * 10000n) fail();
  return BigInt(value);
};
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) fail(); return Number(value); };
const sum = rows => rows.reduce((result, row) => ({ cost: result.cost + micros(row.cost_micros),
  clicks: safe(BigInt(result.clicks) + BigInt(row.clicks)), leads: safe(BigInt(result.leads) + BigInt(row.leads)) }), { cost: 0n, clicks: 0, leads: 0 });
const enough = row => row.leads >= POLICY.minimum_leads && row.clicks >= POLICY.minimum_clicks && row.leads <= row.clicks && row.cost > 0n;
const qualifies = daily => {
  const before = sum(daily.slice(0, 14)); const after = sum(daily.slice(14));
  return enough(before) && enough(after) && after.cost * BigInt(before.leads) * 100n
    >= before.cost * BigInt(after.leads) * BigInt(100 + POLICY.increase_percent);
};

// A lead-cost comparison cannot establish the right CPA/ROAS target for a different conversion goal.
function supportedBidTarget(target, reference) {
  return target?.action === ACTION && id(target.id) && (reference.provider === 'google_ads'
    ? target.entity === 'ad_group' && target.strategy === 'MANUAL_CPC' && target.field === 'cpc_bid_micros' && target.unit === 'micros'
    : target.entity === 'ad_set' && target.strategy === 'LOWEST_COST_WITH_BID_CAP' && target.field === 'bid_amount' && target.unit === 'minor');
}

function reducedBid(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,21}$/.test(value)) fail();
  const before = BigInt(value);
  // Round towards the current bid, never exceed the chosen percentage because of provider units.
  const next = (before * BigInt(100 - POLICY.reduction_percent) + 99n) / 100n;
  return next > 0n && next < before ? String(next) : null;
}

const FIELDS = ['schema_version', 'rule', 'policy_version', 'setting_id', 'mandate_id', 'clinic_id', 'reference',
  'source_fingerprint', 'collection_fingerprint', 'evaluation_key', 'observed_at', 'window_start', 'window_end',
  'group_id', 'target_fingerprint', 'before', 'after', 'daily'];

function validateBidEvidence(proof, now, change) {
  if (!exactKeys(proof, FIELDS) || proof.schema_version !== 3 || proof.rule !== 'bid_efficiency' || proof.policy_version !== POLICY.version
    || !uuid(proof.setting_id) || !uuid(proof.mandate_id) || !integer(proof.clinic_id) || proof.clinic_id <= 0 || !id(proof.group_id)
    || !['source_fingerprint', 'collection_fingerprint', 'evaluation_key', 'target_fingerprint'].every(key => hash(proof[key]))
    || typeof proof.observed_at !== 'string' || !Number.isFinite(Date.parse(proof.observed_at))
    || new Date(proof.observed_at).toISOString() !== proof.observed_at || +new Date(proof.observed_at) > +now
    || +now - +new Date(proof.observed_at) >= POLICY.evidence_ttl_ms || !Array.isArray(proof.daily) || proof.daily.length !== 28) fail();
  optimizationReference(proof.reference); const period = performancePeriod(now);
  if (proof.window_start !== period.start || proof.window_end !== period.end) fail();
  for (const [index, row] of proof.daily.entries()) {
    if (!exactKeys(row, ['date', 'clicks', 'leads', 'cost_micros']) || row.date !== dayAt(period.start, index)
      || !integer(row.clicks) || !integer(row.leads)) fail();
    micros(row.cost_micros);
  }
  if (!qualifies(proof.daily) || proof.after !== reducedBid(proof.before) || !proof.after) fail();
  if (!change || !supportedBidTarget(change.target, proof.reference) || proof.target_fingerprint !== digest(change.target)
    || digest(proof.reference) !== digest(change.reference) || proof.group_id !== change.target.id
    || proof.before !== change.before || proof.after !== change.after) fail();
  return structuredClone(proof);
}

function buildBidProposals(collection, { evaluationKey, now = new Date() }) {
  if (!hash(evaluationKey)) fail();
  const source = validateOptimizationCollection(collection, now, ACTION);
  if (!Array.isArray(source.bid_controls) || source.bid_controls.length > 2000) fail();
  if (source.attribution.complete !== true || source.attribution.unattributed_leads !== 0
    || source.reception?.checked !== true || source.reception.ready !== true || source.reception.state !== 'verified') return [];
  const period = source.performance.period; const dates = Array.from({ length: 28 }, (_, index) => dayAt(period.start, index));
  const allowedDates = new Set(dates); const groups = new Map(); const metrics = new Map(); const leads = new Map();
  for (const ad of source.performance.inventory) {
    if (!groups.has(ad.group_id)) groups.set(ad.group_id, []);
    groups.get(ad.group_id).push(ad);
  }
  for (const row of source.performance.ad_daily) metrics.set(`${row.date}:${row.group_id}:${row.ad_id}`, row);
  for (const row of source.attribution.ad_daily) {
    const key = `${row.date}:${row.group_id}:${row.ad_id}`;
    if (!allowedDates.has(row.date) || !integer(row.leads) || leads.has(key)
      || !groups.get(row.group_id)?.some(ad => ad.id === row.ad_id)) fail();
    leads.set(key, row.leads);
  }
  const candidates = [];
  for (const target of source.authorization_targets) {
    if (!supportedBidTarget(target, source.reference)) continue;
    const matched = source.bid_controls.filter(control => {
      const { value, ...identity } = control; return digest(identity) === digest(target);
    });
    if (matched.length !== 1) continue;
    const ads = groups.get(target.id);
    if (!ads?.some(ad => ad.active) || ads.some(ad => dates.some(date => !metrics.has(`${date}:${ad.group_id}:${ad.id}`)))) continue;
    const daily = dates.map(date => {
      const rows = ads.map(ad => { const key = `${date}:${ad.group_id}:${ad.id}`; return { ...metrics.get(key), leads: leads.get(key) || 0 }; });
      const total = sum(rows); return { date, clicks: total.clicks, leads: total.leads, cost_micros: String(total.cost) };
    });
    if (!qualifies(daily)) continue;
    const before = matched[0].value; const after = reducedBid(before); if (!after) continue;
    const change = optimizationChange({ reference: source.reference, target, before, after });
    const proof = { schema_version: 3, rule: 'bid_efficiency', policy_version: POLICY.version, setting_id: source.setting_id,
      mandate_id: source.mandate_id, clinic_id: source.clinic_id, reference: source.reference, source_fingerprint: source.source_fingerprint,
      collection_fingerprint: collection.fingerprint, evaluation_key: evaluationKey, observed_at: source.observed_at,
      window_start: period.start, window_end: period.end, group_id: target.id, target_fingerprint: digest(target), before, after, daily };
    validateBidEvidence(proof, now, change); candidates.push({ change, evidence: proof });
  }
  // One bid decision per campaign/cycle; prefer the largest observed recent expense deterministically.
  candidates.sort((a, b) => {
    const delta = sum(b.evidence.daily.slice(14)).cost - sum(a.evidence.daily.slice(14)).cost;
    return delta < 0n ? -1 : delta > 0n ? 1 : a.change.target.id.localeCompare(b.change.target.id);
  });
  return candidates.slice(0, 1);
}

module.exports = { POLICY, supportedBidTarget, reducedBid, validateBidEvidence, buildBidProposals };
