'use strict';

const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { optimizationChange } = require('./campaignWorkspaceOptimizationCommand.service');
const { performancePeriod } = require('./campaignWorkspacePerformanceSnapshot.service');
const { validateOptimizationCollection } = require('./campaignWorkspaceOptimizationEvidenceValidation.service');

const POLICY = Object.freeze({ version: 1, days_per_window: 14, minimum_leads: 20, minimum_clicks: 100,
  deterioration_percent: 50, improvement_percent: 25, utilization_percent: 90, change_percent: 5,
  cooldown_hours: 336, evidence_ttl_ms: 900000 });
const ACTION = 'adjust_budget';
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
const sum = rows => rows.reduce((total, row) => ({ cost: total.cost + micros(row.cost_micros),
  clicks: safe(BigInt(total.clicks) + BigInt(row.clicks)), leads: safe(BigInt(total.leads) + BigInt(row.leads)) }), { cost: 0n, clicks: 0, leads: 0 });
const enough = row => row.leads >= POLICY.minimum_leads && row.clicks >= POLICY.minimum_clicks && row.leads <= row.clicks && row.cost > 0n;

function supportedBudgetTarget(target, reference) {
  return target?.action === ACTION && id(target.id) && (reference.provider === 'google_ads'
    ? target.entity === 'campaign_budget' && target.field === 'amount_micros' && target.unit === 'micros'
    : ['campaign', 'ad_set'].includes(target.entity) && target.field === 'daily_budget' && target.unit === 'minor');
}

function adjustedBudget(before, direction) {
  if (typeof before !== 'string' || !/^[1-9][0-9]{0,21}$/.test(before) || !['increase', 'decrease'].includes(direction)) fail();
  const old = BigInt(before); const delta = old * BigInt(POLICY.change_percent) / 100n;
  return delta ? String(direction === 'increase' ? old + delta : old - delta) : null;
}

function budgetDirection(daily, before, unit) {
  const older = sum(daily.slice(0, 14)); const recent = sum(daily.slice(14));
  if (!enough(older) || !enough(recent)) return null;
  const compared = recent.cost * BigInt(older.leads) * 100n;
  const baseline = older.cost * BigInt(recent.leads);
  if (compared >= baseline * BigInt(100 + POLICY.deterioration_percent)) return 'decrease';
  const dailyMicros = micros(before) * (unit === 'minor' ? 10000n : 1n);
  // A lower CPL alone does not establish a need for more budget; require observed use near the current daily allowance.
  if (compared <= baseline * BigInt(100 - POLICY.improvement_percent)
    && recent.cost * 100n >= dailyMicros * BigInt(POLICY.days_per_window * POLICY.utilization_percent)) return 'increase';
  return null;
}

const FIELDS = ['schema_version', 'rule', 'policy_version', 'setting_id', 'mandate_id', 'clinic_id', 'reference',
  'source_fingerprint', 'collection_fingerprint', 'evaluation_key', 'observed_at', 'window_start', 'window_end',
  'target_fingerprint', 'before', 'after', 'direction', 'daily'];

function validateBudgetEvidence(proof, now, change) {
  if (!exactKeys(proof, FIELDS) || proof.schema_version !== 4 || proof.rule !== 'budget_efficiency' || proof.policy_version !== POLICY.version
    || !uuid(proof.setting_id) || !uuid(proof.mandate_id) || !integer(proof.clinic_id) || proof.clinic_id <= 0
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
  if (!change || !supportedBudgetTarget(change.target, proof.reference) || proof.target_fingerprint !== digest(change.target)
    || digest(proof.reference) !== digest(change.reference) || proof.before !== change.before || proof.after !== change.after
    || proof.direction !== budgetDirection(proof.daily, proof.before, change.target.unit)
    || proof.after !== adjustedBudget(proof.before, proof.direction) || !proof.after) fail();
  return structuredClone(proof);
}

function buildBudgetProposals(collection, { evaluationKey, now = new Date() }) {
  if (!hash(evaluationKey)) fail();
  const source = validateOptimizationCollection(collection, now, ACTION);
  if (!Array.isArray(source.budget_controls) || source.budget_controls.length > 2000) fail();
  if (source.attribution.complete !== true || source.attribution.unattributed_leads !== 0
    || source.reception?.checked !== true || source.reception.ready !== true || source.reception.state !== 'verified') return [];
  const period = source.performance.period; const dates = Array.from({ length: 28 }, (_, index) => dayAt(period.start, index));
  const allowedDates = new Set(dates); const inventory = source.performance.inventory;
  const adKeys = new Set(inventory.map(ad => `${ad.group_id}:${ad.id}`)); const metrics = new Map(); const leads = new Map();
  for (const row of source.performance.ad_daily) metrics.set(`${row.date}:${row.group_id}:${row.ad_id}`, row);
  for (const row of source.attribution.ad_daily) {
    const key = `${row.date}:${row.group_id}:${row.ad_id}`;
    if (!allowedDates.has(row.date) || !integer(row.leads) || leads.has(key) || !adKeys.has(`${row.group_id}:${row.ad_id}`)) fail();
    leads.set(key, row.leads);
  }
  const candidates = [];
  for (const target of source.authorization_targets) {
    if (!supportedBudgetTarget(target, source.reference)) continue;
    const matched = source.budget_controls.filter(control => {
      const { value, ...identity } = control; return digest(identity) === digest(target);
    });
    if (matched.length !== 1) continue;
    const ads = target.entity === 'ad_set' ? inventory.filter(ad => ad.group_id === target.id) : inventory;
    if (!ads.some(ad => ad.active) || ads.some(ad => dates.some(date => !metrics.has(`${date}:${ad.group_id}:${ad.id}`)))) continue;
    const daily = dates.map(date => {
      const total = sum(ads.map(ad => { const key = `${date}:${ad.group_id}:${ad.id}`; return { ...metrics.get(key), leads: leads.get(key) || 0 }; }));
      return { date, clicks: total.clicks, leads: total.leads, cost_micros: String(total.cost) };
    });
    const before = matched[0].value; const direction = budgetDirection(daily, before, target.unit); if (!direction) continue;
    const after = adjustedBudget(before, direction); if (!after) continue;
    const change = optimizationChange({ reference: source.reference, target, before, after });
    const proof = { schema_version: 4, rule: 'budget_efficiency', policy_version: POLICY.version, setting_id: source.setting_id,
      mandate_id: source.mandate_id, clinic_id: source.clinic_id, reference: source.reference, source_fingerprint: source.source_fingerprint,
      collection_fingerprint: collection.fingerprint, evaluation_key: evaluationKey, observed_at: source.observed_at,
      window_start: period.start, window_end: period.end, target_fingerprint: digest(target), before, after, direction, daily };
    validateBudgetEvidence(proof, now, change); candidates.push({ change, evidence: proof });
  }
  // One decision per campaign/cycle, reductions first. Monthly scope accounting remains mandatory at execution.
  candidates.sort((a, b) => {
    if (a.evidence.direction !== b.evidence.direction) return a.evidence.direction === 'decrease' ? -1 : 1;
    const delta = sum(b.evidence.daily.slice(14)).cost - sum(a.evidence.daily.slice(14)).cost;
    return delta < 0n ? -1 : delta > 0n ? 1 : a.change.target.id.localeCompare(b.change.target.id);
  });
  return candidates.slice(0, 1);
}

module.exports = { POLICY, supportedBudgetTarget, adjustedBudget, validateBudgetEvidence, buildBudgetProposals };
