'use strict';

// Read-only reporting. This module cannot call Google, start jobs or enable BigQuery.
const { isGlobalAdmin } = require('../lib/role-helpers');
const { amountToUnits, unitsToAmount } = require('../../services/aws-cost-collector/src/costs');
const fail = code => { throw Object.assign(Error(code), { code }); };
const keyFor = month => `google:clinicaclick:${month}`;
function monthsAt(now) {
  return [now.toISOString().slice(0, 7), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)];
}
function projectSnapshot(value, month) {
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const amount = v => {
    const pattern = value?.version === 2 ? /^-?\d{1,12}(\.\d{1,9})?$/ : /^-?\d{1,12}(\.\d{1,2})?$/;
    if (typeof v !== 'string' || !pattern.test(v)) fail('google_cost_snapshot_invalid');
    return unitsToAmount(amountToUnits(v));
  };
  const automatic = value?.version === 2;
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || !value || ![1, 2].includes(value.version)
    || value.month !== month || value.projectId !== 'clinicaclick'
    || value.source !== (automatic ? 'google_cloud_billing_bigquery' : 'google_cloud_billing_report')
    || value.currency !== 'EUR' || value.precision !== (automatic ? 'numeric_9' : 'report_cents') || value.invoice !== false
    || typeof value.collectedAt !== 'string' || !Number.isFinite(Date.parse(value.collectedAt))
    || !date(value.period?.from) || !date(value.period?.toExclusive) || value.period.from !== month + '-01'
    || value.period.toExclusive <= value.period.from
    || Date.parse(value.period.toExclusive) > Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)
    || Date.parse(value.period.toExclusive) > Date.parse(value.collectedAt)
    || !Array.isArray(value.services) || value.services.length > 100
    || (automatic && (value.provisional !== true || !date(value.latestUsageDay)
      || value.latestUsageDay < value.period.from || value.latestUsageDay >= value.period.toExclusive))) fail('google_cost_snapshot_invalid');
  const names = new Set();
  const services = value.services.map(row => {
    if (typeof row.service !== 'string' || !/^[\p{L}\p{N} ()+.,&/-]{1,100}$/u.test(row.service) || names.has(row.service)) fail('google_cost_snapshot_invalid');
    names.add(row.service);
    const result = { service: row.service, gross: amount(row.gross), credits: amount(row.credits), net: amount(row.net) };
    if (amountToUnits(result.gross) + amountToUnits(result.credits) !== amountToUnits(result.net)) fail('google_cost_snapshot_invalid');
    return result;
  });
  const totals = Object.fromEntries(['gross', 'credits', 'net'].map(key => {
    const total = amount(value[key]);
    if (services.reduce((sum, row) => sum + amountToUnits(row[key]), 0n) !== amountToUnits(total)) fail('google_cost_snapshot_invalid');
    return [key, total];
  }));
  return { version: value.version, source: value.source, projectId: 'clinicaclick', month,
    collectedAt: new Date(value.collectedAt).toISOString(), currency: 'EUR', precision: value.precision, invoice: false,
    ...(automatic ? { provisional: true, latestUsageDay: value.latestUsageDay } : {}),
    period: { from: value.period.from, toExclusive: value.period.toExclusive }, ...totals, services };
}
function createService({ repository, now = () => new Date(), env = process.env }) {
  return {
    async getOverview({ userId, month } = {}) {
      if (!isGlobalAdmin(userId)) fail('technical_admin_required');
      const time = now(); const availableMonths = monthsAt(time); month ??= availableMonths[0];
      if (!availableMonths.includes(month)) fail('cost_period_invalid');
      const record = await repository.read(keyFor(month));
      const snapshot = record ? projectSnapshot(record.snapshot, month) : null;
      if (snapshot && Date.parse(snapshot.collectedAt) > time.getTime() + 60000) fail('google_cost_snapshot_invalid');
      const automatic = env.GOOGLE_CLOUD_COSTS_WEEKLY_ENABLED === 'true'
        && env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_WEEKLY_ENABLED === 'true';
      return { version: 1, month, availableMonths, collectionMode: automatic ? 'weekly_combined' : 'manual', automaticCollectionEnabled: automatic,
        schedule: automatic ? { cron: env.JOBS_COMPETITION_SCHEDULE || '0 6 * * 1', timezone: 'Europe/Madrid' } : null,
        coverage: 'shared_google_project', comparisonWithAwsAndAi: 'separate_do_not_add',
        status: !snapshot ? 'pending' : time - Date.parse(snapshot.collectedAt) > 8 * 86400000 ? 'stale' : 'available', snapshot };
    },
  };
}
module.exports = { keyFor, projectSnapshot, createService,
  getOverview: input => createService({ repository: {
    read: key => require('../../models').GoogleCloudCostCache.findByPk(key, { raw: true, attributes: ['snapshot'] }),
  } }).getOverview(input),
};
