'use strict';

const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { performancePeriod } = require('./campaignWorkspacePerformanceSnapshot.service');
const { validateOptimizationCollection } = require('./campaignWorkspaceOptimizationEvidenceValidation.service');

const POLICY = Object.freeze({ version: 1, days_per_window: 14, minimum_leads: 10, minimum_clicks: 100,
  cost_multiplier: 2, evidence_ttl_ms: 15 * 60000, cooldown_hours: 24 });
const ACTION = 'pause_underperforming_ads';
const fail = () => { throw Object.assign(new Error('workspace_optimization_evidence_invalid'), { code: 'workspace_optimization_evidence_invalid' }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const dateShift = (day, delta) => new Date(Date.parse(`${day}T12:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
const micro = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,21})$/.test(value)) fail();
  const amount = BigInt(value); if (amount > BigInt(Number.MAX_SAFE_INTEGER) * 10000n) fail(); return amount;
};
const safeNumber = value => { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(); return Number(value); };
const safeDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function aggregate(daily, baseline = false) {
  const prefix = baseline ? 'baseline_' : '';
  const value = daily.reduce((sum, day) => ({ clicks: sum.clicks + BigInt(day[`${prefix}clicks`]),
    leads: sum.leads + BigInt(day[`${prefix}leads`]), cost: sum.cost + micro(day[`${prefix}cost_micros`]) }), { clicks: 0n, leads: 0n, cost: 0n });
  return { ...value, clicks: safeNumber(value.clicks), leads: safeNumber(value.leads), cost_cents: safeNumber((value.cost + 5000n) / 10000n) };
}

function enough(value) {
  return value.leads >= POLICY.minimum_leads && value.clicks >= POLICY.minimum_clicks && value.leads <= value.clicks && value.cost_cents > 0;
}

function metrics(daily) {
  const a = aggregate(daily); const b = aggregate(daily, true);
  return { clicks: a.clicks, leads: a.leads, cost_cents: a.cost_cents,
    baseline_clicks: b.clicks, baseline_leads: b.leads, baseline_cost_cents: b.cost_cents };
}

function qualifies(daily) {
  return [daily.slice(0, 14), daily.slice(14)].every(window => {
    const a = aggregate(window); const b = aggregate(window, true);
    return enough(a) && enough(b) && a.cost * BigInt(b.leads) >= BigInt(POLICY.cost_multiplier) * b.cost * BigInt(a.leads);
  });
}

const PROOF_KEYS = ['schema_version', 'rule', 'policy_version', 'setting_id', 'mandate_id', 'clinic_id', 'reference',
  'evaluation_key', 'source_fingerprint', 'collection_fingerprint', 'observed_at', 'window_start', 'window_end',
  'ad_id', 'baseline_ad_id', 'group_id', 'daily', 'metrics'];

function validateAdPauseEvidence(proof, now, change = null) {
  if (!keys(proof, PROOF_KEYS) || proof.schema_version !== 2 || proof.rule !== 'ad_underperformance' || proof.policy_version !== POLICY.version
    || !hash(proof.evaluation_key) || !hash(proof.source_fingerprint) || !hash(proof.collection_fingerprint)
    || !id(proof.ad_id) || !id(proof.baseline_ad_id) || proof.ad_id === proof.baseline_ad_id || !id(proof.group_id)
    || !integer(proof.clinic_id) || proof.clinic_id <= 0
    || !uuid(proof.setting_id) || !uuid(proof.mandate_id)
    || !safeDate(proof.observed_at) || +new Date(proof.observed_at) > +now
    || +now - +new Date(proof.observed_at) >= POLICY.evidence_ttl_ms || !Array.isArray(proof.daily) || proof.daily.length !== 28) fail();
  optimizationReference(proof.reference);
  const period = performancePeriod(now);
  if (proof.window_start !== period.start || proof.window_end !== period.end) fail();
  const fields = ['date', 'clicks', 'leads', 'cost_micros', 'baseline_clicks', 'baseline_leads', 'baseline_cost_micros'];
  for (const [index, day] of proof.daily.entries()) {
    if (!keys(day, fields) || day.date !== dateShift(period.start, index)
      || ['clicks', 'leads', 'baseline_clicks', 'baseline_leads'].some(key => !integer(day[key]))) fail();
    micro(day.cost_micros); micro(day.baseline_cost_micros);
  }
  if (!qualifies(proof.daily) || digest(proof.metrics) !== digest(metrics(proof.daily))) fail();
  if (change && (change.target.action !== ACTION || digest(change.reference) !== digest(proof.reference)
    || change.target.id !== proof.ad_id || change.target.group_id !== proof.group_id)) fail();
  return structuredClone(proof);
}

// This is an explicit operational heuristic, not a causal winner or a statistical experiment.
function buildAdPauseProposals(collection, { evaluationKey, now = new Date() }) {
  if (!hash(evaluationKey)) fail();
  const source = validateOptimizationCollection(collection, now, ACTION); const snapshot = source.performance;
  if (source.attribution.complete !== true || source.attribution.unattributed_leads !== 0
    || source.reception?.checked !== true || source.reception.ready !== true || source.reception.state !== 'verified') return [];
  const dates = Array.from({ length: 28 }, (_, index) => dateShift(snapshot.period.start, index));
  const allowedDates = new Set(dates); const inventory = new Map(); const daily = new Map(); const leadDaily = new Map();
  for (const ad of snapshot.inventory) {
    const key = `${ad.group_id}~${ad.id}`;
    if (!id(ad.id) || !id(ad.group_id) || typeof ad.active !== 'boolean' || inventory.has(key)) fail();
    inventory.set(key, ad);
  }
  for (const row of snapshot.ad_daily) {
    const key = `${row.group_id}~${row.ad_id}`; const point = `${row.date}:${key}`;
    if (!inventory.has(key) || !allowedDates.has(row.date) || daily.has(point) || !integer(row.clicks)) fail();
    micro(row.cost_micros); daily.set(point, row);
  }
  for (const row of source.attribution.ad_daily) {
    const key = `${row.group_id}~${row.ad_id}`; const point = `${row.date}:${key}`;
    if (!inventory.has(key) || !allowedDates.has(row.date) || leadDaily.has(point) || !integer(row.leads)) fail();
    leadDaily.set(point, row.leads);
  }
  const groups = new Map();
  for (const [key, ad] of inventory) {
    if (!ad.active || dates.some(day => !daily.has(`${day}:${key}`))) continue;
    const points = dates.map(date => ({ date, clicks: daily.get(`${date}:${key}`).clicks,
      cost_micros: daily.get(`${date}:${key}`).cost_micros, leads: leadDaily.get(`${date}:${key}`) || 0 }));
    if (![points.slice(0, 14), points.slice(14)].every(window => enough(aggregate(window)))) continue;
    if (!groups.has(ad.group_id)) groups.set(ad.group_id, []);
    groups.get(ad.group_id).push({ ...ad, points, total: aggregate(points) });
  }
  const proposals = [];
  const compare = (a, b) => {
    const diff = a.total.cost * BigInt(b.total.leads) - b.total.cost * BigInt(a.total.leads);
    return diff < 0n ? -1 : diff > 0n ? 1 : a.id.localeCompare(b.id);
  };
  for (const [groupId, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(compare); const baseline = ordered[0];
    for (const candidate of [...ordered].reverse()) {
      if (candidate.id === baseline.id) continue;
      const targets = source.authorization_targets.filter(target => target.action === ACTION && target.id === candidate.id && target.group_id === groupId);
      if (targets.length !== 1) continue;
      const points = candidate.points.map((row, index) => ({ ...row, baseline_clicks: baseline.points[index].clicks,
        baseline_leads: baseline.points[index].leads, baseline_cost_micros: baseline.points[index].cost_micros }));
      if (!qualifies(points)) continue;
      const proof = { schema_version: 2, rule: 'ad_underperformance', policy_version: POLICY.version, setting_id: source.setting_id,
        mandate_id: source.mandate_id, clinic_id: source.clinic_id, reference: source.reference, evaluation_key: evaluationKey,
        source_fingerprint: source.source_fingerprint, collection_fingerprint: collection.fingerprint, observed_at: source.observed_at,
        window_start: snapshot.period.start, window_end: snapshot.period.end, ad_id: candidate.id, baseline_ad_id: baseline.id,
        group_id: groupId, daily: points, metrics: metrics(points) };
      validateAdPauseEvidence(proof, now);
      const change = require('./campaignWorkspaceOptimizationCommand.service').optimizationChange({ reference: source.reference,
        target: targets[0], before: source.reference.provider === 'google_ads' ? 'ENABLED' : 'ACTIVE', after: 'PAUSED' });
      proposals.push({ change, evidence: proof }); break;
    }
  }
  return proposals;
}

function assertPauseBaseline(inspection, evidence, change) {
  if (evidence.schema_version !== 2 || change.target.action !== ACTION) return;
  if (!inspection || digest(inspection.reference) !== digest(change.reference) || inspection.currency !== 'EUR'
    || !Array.isArray(inspection.targets) || inspection.targets.filter(target => target.action === ACTION
      && target.id === evidence.baseline_ad_id && target.group_id === evidence.group_id && target.value === change.before).length !== 1) {
    throw Object.assign(new Error('workspace_optimization_baseline_changed'), { code: 'workspace_optimization_baseline_changed' });
  }
}

module.exports = { POLICY, buildAdPauseProposals, validateAdPauseEvidence, assertPauseBaseline };
