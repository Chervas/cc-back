'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { Op } = require('sequelize');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { VERSION, ACCOUNT_VERSION, COMPONENTS, ENVIRONMENTS, scopeFor, componentCoverage, filterDigestFor,
  accountFilterDigestFor, costClassFor, costBreakdownFor, viewCache, amountToUnits, unitsToAmount } = require('../../services/aws-cost-collector/src/costs');
const { ACCOUNT, ROLE, MAX_CE_COMMANDS_PER_MONTH, SDK_MAX_ATTEMPTS, safeError } = require('../../services/aws-cost-collector/src/report');
const fail = (code, status = 503) => { throw Object.assign(Error(code), { code, status }); };
// Keep both legacy scopes and pre-digest v2 snapshots isolated; full digest still fits STRING(96).
const FILTER_DIGEST = filterDigestFor({ accountId: ACCOUNT, environment: 'prod' });
const keyFor = month => `aws:infrastructure:v${VERSION}:${FILTER_DIGEST}:${month}`;
const ACCOUNT_FILTER_DIGEST = accountFilterDigestFor({ accountId: ACCOUNT, environment: 'prod' });
const accountKeyFor = month => `aws:account:v${ACCOUNT_VERSION}:${ACCOUNT_FILTER_DIGEST}:${month}`;
const collectionIdValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const CACHE_CODES = new Set(['cost_migration_required', 'cost_cache_unavailable', 'cost_snapshot_invalid', 'cost_data_pending',
  'cost_tags_unverified', 'cost_identity_invalid', 'cost_aws_unavailable', 'cost_scope_invalid', 'cost_response_invalid',
  'cost_amount_invalid', 'cost_period_invalid', 'cost_currency_mismatch', 'cost_pagination_invalid', 'cost_duplicate_group',
  'cost_pagination_limit', 'cost_collector_unavailable', 'cost_call_budget_exceeded', 'cost_credentials_invalid', 'cost_credentials_unavailable']);
function monthsAt(now) {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [now.toISOString().slice(0, 7), previous.toISOString().slice(0, 7)];
}
function projectSnapshot(value, month) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const amount = value => value === null ? null : unitsToAmount(amountToUnits(value));
  const currency = value => value === null || /^[A-Z]{3}$/.test(value) ? value : fail('cost_snapshot_invalid');
  if (!value || value.version !== VERSION || value.source !== 'aws_cost_explorer' || value.metric !== 'UnblendedCost'
    || value.filterDigest !== FILTER_DIGEST || Object.keys(value.scope || {}).sort().join(',') !== 'application,components,environments'
    || value.scope?.application !== 'clinicaclick' || !Array.isArray(value.scope?.environments)
    || value.scope.environments.length !== ENVIRONMENTS.length || ENVIRONMENTS.some(env => !value.scope.environments.includes(env))
    || !Array.isArray(value.scope.components) || value.scope.components.length !== COMPONENTS.length
    || COMPONENTS.some(component => !value.scope.components.includes(component)) || value.coverage !== 'tagged_resources_only'
    || value.month !== month || value.environment !== 'platform' || !['pending', 'available'].includes(value.status)
    || !Number.isFinite(Date.parse(value.collectedAt)) || !validDate(value.period?.from) || !validDate(value.period?.toExclusive)
    || value.period.from !== month + '-01' || value.period.toExclusive < value.period.from
    || Date.parse(value.period.toExclusive) > Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
    || !Array.isArray(value.rows) || value.rows.length > 10000) fail('cost_snapshot_invalid');
  const rows = value.rows.map(row => {
    if (!validDate(row.date) || row.date < value.period.from || row.date >= value.period.toExclusive
      || !COMPONENTS.includes(row.component) || typeof row.service !== 'string' || row.service.length > 200
      || !row.service || row.amount === null || row.currency === null) fail('cost_snapshot_invalid');
    return { date: row.date, service: row.service, component: row.component, amount: amount(row.amount), currency: currency(row.currency) };
  });
  if (value.status === 'available' && (value.amount === null || value.currency === null)) fail('cost_snapshot_invalid');
  if (value.collectionId !== undefined && !collectionIdValid(value.collectionId)) fail('cost_snapshot_invalid');
  if (value.status === 'available' && (rows.some(row => row.currency !== value.currency)
    || rows.reduce((sum, row) => sum + amountToUnits(row.amount), 0n) !== amountToUnits(value.amount))) fail('cost_snapshot_invalid');
  const services = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.service, row.component, row.currency]);
    const current = services.get(key) || { service: row.service, component: row.component, currency: row.currency, total: 0n };
    current.total += amountToUnits(row.amount); services.set(key, current);
  }
  const money = input => {
    if (!input || !['available', 'pending', 'not_applicable'].includes(input.status)) fail('cost_snapshot_invalid');
    if (input.status === 'available' && (input.amount === null || input.currency === null)) fail('cost_snapshot_invalid');
    return { status: input.status, amount: amount(input.amount), currency: currency(input.currency) };
  };
  const forecast = money(value.forecast); const budget = money(value.budget);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value.budget.referenceMonth)) fail('cost_snapshot_invalid');
  if (value.forecast.status === 'available') {
    if (!validDate(value.forecast.period?.from) || !validDate(value.forecast.period?.toExclusive)) fail('cost_snapshot_invalid');
    forecast.period = { from: value.forecast.period.from, toExclusive: value.forecast.period.toExclusive };
  }
  return { version: VERSION, source: 'aws_cost_explorer', metric: 'UnblendedCost', month, environment: 'platform',
    collectedAt: new Date(value.collectedAt).toISOString(), period: { from: value.period.from, toExclusive: value.period.toExclusive },
    status: value.status, amount: amount(value.amount), currency: currency(value.currency), estimated: value.estimated === true,
    rows, services: [...services.values()].map(({ total, ...rest }) => ({ ...rest, amount: unitsToAmount(total), costClass: costClassFor(rest) })),
    filterDigest: FILTER_DIGEST, costBreakdown: costBreakdownFor(rows),
    forecast: { ...forecast, kind: 'remaining_period' },
    budget: { ...budget, source: 'aws_budgets', scopeMatches: value.budget.scopeMatches === true,
      metricMatches: value.budget.metricMatches === true, hardLimit: false, period: 'monthly', referenceMonth: value.budget.referenceMonth },
    scope: scopeFor(), componentCoverage: componentCoverage(rows),
    coverage: 'tagged_resources_only', coverageStatus: 'observed_partial', excludesAiEstimates: true, invoice: false,
    ...(value.collectionId ? { collectionId: value.collectionId } : {}),
    billingTimeZone: 'UTC', scheduleTimeZone: 'Europe/Madrid' };
}
function projectAccountSnapshot(value, month) {
  const invalid = () => fail('cost_snapshot_invalid');
  const date = input => typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)
    && Number.isFinite(Date.parse(input)) && new Date(input).toISOString().slice(0, 10) === input;
  if (!value || value.version !== ACCOUNT_VERSION || value.month !== month || value.source !== 'aws_cost_explorer'
    || value.metric !== 'UnblendedCost' || value.environment !== 'platform' || value.coverage !== 'linked_account_reported'
    || value.filterDigest !== ACCOUNT_FILTER_DIGEST || !collectionIdValid(value.collectionId)
    || Object.keys(value.scope || {}).sort().join(',') !== 'allServices,mode,resourceTagFilter'
    || value.scope.mode !== 'linked_account' || value.scope.allServices !== true || value.scope.resourceTagFilter !== false
    || !['pending', 'available'].includes(value.status) || !Number.isFinite(Date.parse(value.collectedAt))
    || !date(value.period?.from) || !date(value.period?.toExclusive) || value.period.from !== month + '-01'
    || value.period.toExclusive < value.period.from
    || Date.parse(value.period.toExclusive) > Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
    || !Array.isArray(value.rows) || value.rows.length > 10000) invalid();
  const currency = input => input === null || typeof input === 'string' && /^[A-Z]{3}$/.test(input) ? input : invalid();
  const amount = input => input === null ? null : unitsToAmount(amountToUnits(input));
  const seen = new Set(); const services = new Map();
  const rows = value.rows.map(row => {
    if (!date(row.date) || row.date < value.period.from || row.date >= value.period.toExclusive
      || typeof row.service !== 'string' || !row.service || row.service.length > 200 || row.amount === null || row.currency === null) invalid();
    const key = JSON.stringify([row.date, row.service]); if (seen.has(key)) invalid(); seen.add(key);
    const projected = { date: row.date, service: row.service, amount: amount(row.amount), currency: currency(row.currency) };
    const service = services.get(row.service) || { service: row.service, currency: projected.currency, total: 0n };
    if (service.currency !== projected.currency) invalid();
    service.total += amountToUnits(projected.amount); services.set(row.service, service); return projected;
  });
  const total = amount(value.amount); const unit = currency(value.currency);
  if (value.status === 'pending' && total !== null) invalid();
  if (value.status === 'available' && (total === null || unit === null || rows.some(row => row.currency !== unit)
    || rows.reduce((sum, row) => sum + amountToUnits(row.amount), 0n) !== amountToUnits(total))) invalid();
  const f = value.forecast;
  if (!f || !['available', 'pending', 'not_applicable'].includes(f.status)
    || f.status !== 'available' && (f.amount !== null || f.currency !== null)
    || f.status === 'available' && (f.amount === null || f.currency === null || !date(f.period?.from) || !date(f.period?.toExclusive))) invalid();
  const c = value.collection;
  if (!c || !Number.isInteger(c.ceLogicalCalls) || c.ceLogicalCalls < 0 || c.ceLogicalCalls > MAX_CE_COMMANDS_PER_MONTH
    || c.sdkMaxAttempts !== SDK_MAX_ATTEMPTS || c.ceRequestAttemptLimit !== MAX_CE_COMMANDS_PER_MONTH * SDK_MAX_ATTEMPTS
    || c.dailyBatchRequestAttemptLimit !== 2 * MAX_CE_COMMANDS_PER_MONTH * SDK_MAX_ATTEMPTS
    || c.ceRequestAttemptUpperBound !== c.ceLogicalCalls * SDK_MAX_ATTEMPTS
    || !['tags', 'usage', 'forecast'].every(name => Number.isInteger(c.ceOperations?.[name]) && c.ceOperations[name] >= 0)
    || ['tags', 'usage', 'forecast'].reduce((sum, name) => sum + c.ceOperations[name], 0) !== c.ceLogicalCalls
    || c.ceRequestAttemptsObserved !== null && (!Number.isInteger(c.ceRequestAttemptsObserved)
      || c.ceRequestAttemptsObserved < c.ceLogicalCalls || c.ceRequestAttemptsObserved > c.ceRequestAttemptUpperBound)) invalid();
  return { version: ACCOUNT_VERSION, month, source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'platform',
    coverage: 'linked_account_reported', coverageStatus: 'observed_partial', filterDigest: ACCOUNT_FILTER_DIGEST,
    scope: { mode: 'linked_account', allServices: true, resourceTagFilter: false }, collectionId: value.collectionId,
    status: value.status, amount: total, currency: unit, estimated: value.estimated === true,
    collectedAt: new Date(value.collectedAt).toISOString(), period: { from: value.period.from, toExclusive: value.period.toExclusive }, rows,
    services: [...services.values()].map(({ total, ...row }) => ({ ...row, amount: unitsToAmount(total) })),
    forecast: { status: f.status, amount: amount(f.amount), currency: currency(f.currency), kind: 'remaining_period',
      ...(f.status === 'available' ? { period: { from: f.period.from, toExclusive: f.period.toExclusive } } : {}) },
    collection: { ceLogicalCalls: c.ceLogicalCalls, ceOperations: { tags: c.ceOperations.tags, usage: c.ceOperations.usage, forecast: c.ceOperations.forecast },
      sdkMaxAttempts: SDK_MAX_ATTEMPTS, ceRequestAttemptLimit: c.ceRequestAttemptLimit, ceRequestAttemptUpperBound: c.ceRequestAttemptUpperBound,
      ceRequestAttemptsObserved: c.ceRequestAttemptsObserved, dailyBatchRequestAttemptLimit: c.dailyBatchRequestAttemptLimit },
    invoice: false, billingTimeZone: 'UTC', scheduleTimeZone: 'Europe/Madrid' };
}
function projectCollection(value, month) {
  if (!value || value.version !== 3 || value.month !== month
    || value.attributionError !== null && !CACHE_CODES.has(value.attributionError)) fail('cost_snapshot_invalid');
  const account = projectAccountSnapshot(value.account, month);
  const attributed = value.attributed === null ? null : projectSnapshot(value.attributed, month);
  if (attributed && (attributed.collectionId !== account.collectionId || attributed.collectedAt !== account.collectedAt
    || JSON.stringify(attributed.period) !== JSON.stringify(account.period))) fail('cost_snapshot_invalid');
  return { version: 3, month, account, attributed, attributionError: value.attributionError };
}
function reconcile(account, attributed) {
  const a = account.snapshot; const t = attributed.snapshot;
  if (!a || !t || a.status !== 'available' || t.status !== 'available' || !t.collectionId || a.collectionId !== t.collectionId
    || a.currency !== t.currency || JSON.stringify(a.period) !== JSON.stringify(t.period)) return { status: 'pending', amount: null, currency: null, services: [] };
  const tagged = new Map();
  for (const row of t.services) tagged.set(row.service, (tagged.get(row.service) || 0n) + amountToUnits(row.amount));
  const services = new Map(a.services.map(row => [row.service, { service: row.service, amount: row.amount, attributedAmount: '0', currency: a.currency }]));
  for (const [service, total] of tagged) {
    const row = services.get(service) || { service, amount: '0', currency: a.currency };
    row.attributedAmount = unitsToAmount(total); services.set(service, row);
  }
  return { status: account.status === 'stale' || attributed.status === 'stale' ? 'stale' : 'available',
    amount: unitsToAmount(amountToUnits(a.amount) - amountToUnits(t.amount)), currency: a.currency,
    services: [...services.values()].map(row => ({ ...row,
      unallocatedAmount: unitsToAmount(amountToUnits(row.amount) - amountToUnits(row.attributedAmount)) })) };
}
function createRepository(model) {
  return {
    async read(key) { return model.findByPk(key, { raw: true }); },
    async acquire(key, now) {
      await model.findOrCreate({ where: { cache_key: key }, defaults: { cache_key: key } });
      const lease = randomUUID();
      const [changed] = await model.update({ lease_token: lease, lease_until: new Date(now.getTime() + 180000), last_attempt_at: now }, {
        where: { cache_key: key, [Op.and]: [
          { [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lt]: now } }] },
          // Reserve a monthly share of the daily request budget atomically.
          // A failed or manually repeated job never spends it again that UTC day.
          { [Op.or]: [{ last_attempt_at: null }, { last_attempt_at: { [Op.lt]: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) } }] },
        ] },
      });
      return changed === 1 ? lease : null;
    },
    async finish(key, lease, snapshot, code, now) {
      const updates = { lease_token: null, lease_until: null, last_attempt_at: now, last_error_code: code };
      if (snapshot) { updates.snapshot = snapshot; updates.collected_at = new Date(snapshot.collectedAt); }
      const [changed] = await model.update(updates, { where: { cache_key: key, lease_token: lease } });
      return changed === 1;
    },
  };
}
function invokeCollector(config, month) {
  const binary = config.nodeBinary;
  try { if (typeof binary !== 'string' || !path.isAbsolute(binary) || !fs.statSync(binary).isFile()) fail('cost_collector_unavailable'); }
  catch { fail('cost_collector_unavailable'); }
  const input = JSON.stringify({ accountId: ACCOUNT, roleArn: ROLE, environment: 'prod', month });
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [path.resolve(__dirname, '../../services/aws-cost-collector/src/main.js')], {
      timeout: 90000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
      // Explicitly exclude all app keys, SSO sessions, NODE_OPTIONS, proxy/TLS overrides and DB credentials.
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_EC2_METADATA_DISABLED: 'true',
        AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
    }, (_error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        if (_error || result.ok !== true) return reject(Error(safeError(Error(result.error))));
        resolve(projectCollection(result.snapshot, month));
      } catch { reject(Error('cost_collector_unavailable')); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
function cacheError(error) {
  return error?.original?.code === 'ER_NO_SUCH_TABLE' || error?.parent?.code === 'ER_NO_SUCH_TABLE'
    ? 'cost_migration_required' : 'cost_cache_unavailable';
}
function createService({ repository, collect, config = () => ({}), now = () => new Date() }) {
  const readCache = async (key, month, projector, time) => {
    let record; let code = null; let snapshot = null;
    try { record = await repository.read(key); } catch (error) { code = cacheError(error); }
    if (record?.snapshot) { try { snapshot = projector(record.snapshot, month); } catch { code = 'cost_snapshot_invalid'; } }
    return viewCache({ snapshot, lastAttemptAt: record?.last_attempt_at || null,
      error: code || (record?.last_error_code ? CACHE_CODES.has(record.last_error_code) ? record.last_error_code : 'cost_cache_unavailable' : null) }, { now: time });
  };
  return {
    async getOverview({ userId, month } = {}) {
      if (!/^[1-9]\d*$/.test(String(userId || '')) || !isGlobalAdmin(userId)) fail('technical_admin_required', 403);
      const time = now(); const availableMonths = monthsAt(time); month ||= availableMonths[0];
      if (!availableMonths.includes(month)) fail('cost_period_invalid', 400);
      const settings = config();
      const [cache, account] = await Promise.all([
        readCache(keyFor(month), month, projectSnapshot, time),
        readCache(accountKeyFor(month), month, projectAccountSnapshot, time),
      ]);
      return { ...cache, version: VERSION, month, availableMonths, collectionEnabled: settings.enabled === true,
        refreshSchedule: { cron: '40 3 * * *', timeZone: 'Europe/Madrid' },
        billingTimeZone: 'UTC', coverage: 'tagged_resources_only', coverageStatus: 'observed_partial', scope: scopeFor(),
        componentCoverage: componentCoverage(cache.snapshot?.rows || []), comparisonWithAi: 'separate_do_not_add',
        account, reconciliation: reconcile(account, cache),
        collectionBudget: { ceRequestAttemptLimitPerBatch: 2 * MAX_CE_COMMANDS_PER_MONTH * SDK_MAX_ATTEMPTS,
          monthsPerBatch: 2, sdkMaxAttempts: SDK_MAX_ATTEMPTS, visitsCollect: false },
        reportedBudget: { amount: '60', currency: 'USD', source: 'provisioning_manifest_unverified',
          components: ['integrations', 'audit'], hardLimit: false } };
    },
    async runDaily() {
      const settings = config();
      if (settings.enabled !== true) return { status: 'completed', skipped: true, reason: 'cost_collection_disabled' };
      const periods = [];
      for (const month of monthsAt(now())) {
        const key = keyFor(month); const accountKey = accountKeyFor(month); let lease; let accountLease;
        try {
          lease = await repository.acquire(key, now());
          if (lease) accountLease = await repository.acquire(accountKey, now());
        }
        catch (error) {
          if (lease) { try { await repository.finish(key, lease, null, cacheError(error), now()); } catch {} }
          periods.push({ month, status: 'failed', code: cacheError(error) }); continue;
        }
        if (!lease || !accountLease) {
          if (lease) await repository.finish(key, lease, null, null, now());
          periods.push({ month, status: 'skipped', reason: 'refresh_in_progress_or_daily_budget_reserved' }); continue;
        }
        try {
          const report = projectCollection(await collect(settings, month), month);
          const outcomes = {};
          for (const [scope, cacheKey, token, snapshot, error] of [
            ['account', accountKey, accountLease, report.account, null],
            ['attributed', key, lease, report.attributed, report.attributionError],
          ]) {
            const previous = await repository.read(cacheKey);
            const pending = !snapshot || snapshot.status === 'pending';
            const save = pending && previous?.snapshot?.status === 'available' ? null : snapshot;
            const saved = await repository.finish(cacheKey, token, save, error || (pending ? 'cost_data_pending' : null), now());
            outcomes[scope] = !saved ? 'lease_lost' : pending ? 'pending' : 'updated';
          }
          periods.push({ month, status: Object.values(outcomes).includes('lease_lost') ? 'skipped'
            : Object.values(outcomes).every(value => value === 'updated') ? 'updated' : 'pending', scopes: outcomes,
            collection: report.account.collection });
        } catch (error) {
          const code = safeError(error);
          try { await repository.finish(key, lease, null, code, now()); } catch {}
          try { await repository.finish(accountKey, accountLease, null, code, now()); } catch {}
          periods.push({ month, status: 'failed', code });
        }
      }
      return { status: periods.some(item => item.status === 'failed') ? 'failed' : 'completed', retryable: false, periods };
    },
  };
}
let instance;
function defaultService() {
  if (!instance) instance = createService({ repository: createRepository(require('../../models').AwsInfrastructureCostCache),
    collect: invokeCollector, config: () => ({ enabled: process.env.AWS_INFRA_COSTS_ENABLED === 'true', nodeBinary: process.env.AWS_INFRA_COSTS_NODE_BINARY }) });
  return instance;
}
module.exports = { createService, createRepository, invokeCollector, projectSnapshot, projectAccountSnapshot, projectCollection,
  reconcile, monthsAt, keyFor, accountKeyFor, cacheErrorCodes: Object.freeze([...CACHE_CODES]),
  getOverview: input => defaultService().getOverview(input), runDaily: () => defaultService().runDaily() };
