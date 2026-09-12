'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { Op } = require('sequelize');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { viewCache, amountToUnits, unitsToAmount } = require('../../services/aws-cost-collector/src/costs');
const { ACCOUNT, ROLE, safeError } = require('../../services/aws-cost-collector/src/report');
const fail = (code, status = 503) => { throw Object.assign(Error(code), { code, status }); };
const keyFor = month => `aws:integrations:prod:${month}`;
const CACHE_CODES = new Set(['cost_migration_required', 'cost_cache_unavailable', 'cost_snapshot_invalid', 'cost_data_pending',
  'cost_tags_unverified', 'cost_identity_invalid', 'cost_aws_unavailable', 'cost_scope_invalid', 'cost_response_invalid',
  'cost_amount_invalid', 'cost_period_invalid', 'cost_currency_mismatch', 'cost_pagination_invalid', 'cost_duplicate_group',
  'cost_pagination_limit', 'cost_collector_unavailable']);
function monthsAt(now) {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [now.toISOString().slice(0, 7), previous.toISOString().slice(0, 7)];
}
function projectSnapshot(value, month) {
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const amount = value => value === null ? null : unitsToAmount(amountToUnits(value));
  const currency = value => value === null || /^[A-Z]{3}$/.test(value) ? value : fail('cost_snapshot_invalid');
  if (!value || value.version !== 1 || value.source !== 'aws_cost_explorer' || value.metric !== 'UnblendedCost'
    || value.month !== month || value.environment !== 'prod' || !['pending', 'available'].includes(value.status)
    || !Number.isFinite(Date.parse(value.collectedAt)) || !validDate(value.period?.from) || !validDate(value.period?.toExclusive)
    || value.period.from !== month + '-01' || value.period.toExclusive < value.period.from
    || Date.parse(value.period.toExclusive) > Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
    || !Array.isArray(value.rows) || value.rows.length > 10000) fail('cost_snapshot_invalid');
  const rows = value.rows.map(row => {
    if (!validDate(row.date) || row.date < value.period.from || row.date >= value.period.toExclusive
      || !['integrations', 'audit'].includes(row.component) || typeof row.service !== 'string' || row.service.length > 200
      || !row.service || row.amount === null || row.currency === null) fail('cost_snapshot_invalid');
    return { date: row.date, service: row.service, component: row.component, amount: amount(row.amount), currency: currency(row.currency) };
  });
  if (value.status === 'available' && (value.amount === null || value.currency === null)) fail('cost_snapshot_invalid');
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
  return { version: 1, source: 'aws_cost_explorer', metric: 'UnblendedCost', month, environment: 'prod',
    collectedAt: new Date(value.collectedAt).toISOString(), period: { from: value.period.from, toExclusive: value.period.toExclusive },
    status: value.status, amount: amount(value.amount), currency: currency(value.currency), estimated: value.estimated === true,
    rows, services: [...services.values()].map(({ total, ...rest }) => ({ ...rest, amount: unitsToAmount(total) })),
    forecast: { ...forecast, kind: 'remaining_period' },
    budget: { ...budget, source: 'aws_budgets', scopeMatches: value.budget.scopeMatches === true,
      metricMatches: value.budget.metricMatches === true, hardLimit: false, period: 'monthly', referenceMonth: value.budget.referenceMonth },
    coverage: 'tagged_resources_only', excludesAiEstimates: true, invoice: false,
    billingTimeZone: 'UTC', scheduleTimeZone: 'Europe/Madrid' };
}
function createRepository(model) {
  return {
    async read(key) { return model.findByPk(key, { raw: true }); },
    async acquire(key, now) {
      await model.findOrCreate({ where: { cache_key: key }, defaults: { cache_key: key } });
      const lease = randomUUID();
      const [changed] = await model.update({ lease_token: lease, lease_until: new Date(now.getTime() + 180000), last_attempt_at: now }, {
        where: { cache_key: key, [Op.or]: [{ lease_until: null }, { lease_until: { [Op.lt]: now } }] },
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
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_EC2_METADATA_V1_DISABLED: 'true',
        AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254',
        AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
    }, (_error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        if (_error || result.ok !== true) return reject(Error(safeError(Error(result.error))));
        resolve(projectSnapshot(result.snapshot, month));
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
  return {
    async getOverview({ userId, month } = {}) {
      if (!/^[1-9]\d*$/.test(String(userId || '')) || !isGlobalAdmin(userId)) fail('technical_admin_required', 403);
      const time = now(); const availableMonths = monthsAt(time); month ||= availableMonths[0];
      if (!availableMonths.includes(month)) fail('cost_period_invalid', 400);
      const settings = config(); let record; let code = null;
      try { record = await repository.read(keyFor(month)); }
      catch (error) { code = cacheError(error); }
      let snapshot = null;
      if (record?.snapshot) { try { snapshot = projectSnapshot(record.snapshot, month); } catch { code = 'cost_snapshot_invalid'; } }
      const cache = viewCache({ snapshot, lastAttemptAt: record?.last_attempt_at || null,
        error: code || (record?.last_error_code ? CACHE_CODES.has(record.last_error_code) ? record.last_error_code : 'cost_cache_unavailable' : null) }, { now: time });
      return { ...cache, version: 1, month, availableMonths, collectionEnabled: settings.enabled === true,
        refreshSchedule: { cron: '40 3 * * *', timeZone: 'Europe/Madrid' },
        billingTimeZone: 'UTC', coverage: 'tagged_resources_only', comparisonWithAi: 'separate_do_not_add',
        reportedBudget: { amount: '60', currency: 'USD', source: 'provisioning_manifest_unverified', hardLimit: false } };
    },
    async runDaily() {
      const settings = config();
      if (settings.enabled !== true) return { status: 'completed', skipped: true, reason: 'cost_collection_disabled' };
      const periods = [];
      for (const month of monthsAt(now())) {
        const key = keyFor(month); let lease;
        try { lease = await repository.acquire(key, now()); }
        catch (error) { periods.push({ month, status: 'failed', code: cacheError(error) }); continue; }
        if (!lease) { periods.push({ month, status: 'skipped', reason: 'refresh_in_progress' }); continue; }
        try {
          const snapshot = projectSnapshot(await collect(settings, month), month);
          const previous = await repository.read(key);
          const pending = snapshot.status === 'pending';
          const save = pending && previous?.snapshot?.status === 'available' ? null : snapshot;
          const saved = await repository.finish(key, lease, save, pending ? 'cost_data_pending' : null, now());
          periods.push({ month, status: saved ? pending ? 'pending' : 'updated' : 'skipped', ...(saved ? {} : { reason: 'lease_lost' }) });
        } catch (error) {
          const code = safeError(error);
          try { await repository.finish(key, lease, null, code, now()); } catch {}
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
module.exports = { createService, createRepository, invokeCollector, projectSnapshot, monthsAt,
  getOverview: input => defaultService().getOverview(input), runDaily: () => defaultService().runDaily() };
