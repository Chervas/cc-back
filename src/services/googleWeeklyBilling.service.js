'use strict';

// One result set, one weekly BigQuery job. No credentials, HTTP or timers here.
const { projectSnapshot, keyFor } = require('./googleCloudCosts.service');
const { amountToUnits, unitsToAmount } = require('../../services/aws-cost-collector/src/costs');
const VIEW = 'clinicaclick.clinicaclick_reporting.api_costs_v1';
const fail = code => { throw Object.assign(Error(code), { code }); };

function cutoffForRun(runKey) {
  const day = /^google-atc-es:(20\d{2}-\d{2}-\d{2})$/.exec(runKey)?.[1];
  if (!day || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day
    || new Date(day).getUTCDay() !== 1) fail('google_weekly_run_invalid');
  return day;
}

function combinedQuery(adsQuery) {
  return `WITH ads AS (${adsQuery}),
costs AS (
  SELECT FORMAT_DATE('%Y-%m', usage_day) AS month, service, currency,
    CAST(SUM(gross) AS STRING) AS gross, CAST(SUM(credits) AS STRING) AS credits,
    CAST(SUM(gross + credits) AS STRING) AS net,
    CAST(MAX(usage_day) AS STRING) AS latestUsageDay
  FROM \`${VIEW}\`
  WHERE usage_day >= DATE_SUB(DATE_TRUNC(@billing_cutoff, MONTH), INTERVAL 1 MONTH)
    AND usage_day < @billing_cutoff
  GROUP BY month, service, currency
)
SELECT 'advertiser' AS kind, TO_JSON_STRING(ads) AS payload FROM ads
UNION ALL
SELECT 'billing' AS kind, TO_JSON_STRING(costs) AS payload FROM costs`;
}

function splitRows(rows, { runKey, collectedAt }) {
  const cutoff = cutoffForRun(runKey);
  if (cutoff > collectedAt.slice(0, 10)) fail('google_weekly_run_invalid');
  const currentMonth = cutoff.slice(0, 7);
  const previousMonth = new Date(Date.UTC(Number(cutoff.slice(0, 4)), Number(cutoff.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const advertisers = [], months = new Map();
  for (const row of rows) {
    let value;
    try { value = JSON.parse(row.payload); } catch { fail('google_weekly_result_invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('google_weekly_result_invalid');
    if (row.kind === 'advertiser') { advertisers.push(value); continue; }
    if (row.kind !== 'billing' || ![previousMonth, currentMonth].includes(value.month) || value.currency !== 'EUR') fail('google_weekly_result_invalid');
    if (!months.has(value.month)) months.set(value.month, []);
    months.get(value.month).push(value);
  }
  const snapshots = [];
  for (const [month, services] of months) {
    const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1)).toISOString().slice(0, 10);
    const totals = Object.fromEntries(['gross', 'credits', 'net'].map(key => [key,
      unitsToAmount(services.reduce((sum, row) => sum + amountToUnits(row[key]), 0n))]));
    snapshots.push(projectSnapshot({ version: 2, source: 'google_cloud_billing_bigquery', projectId: 'clinicaclick',
      month, collectedAt, precision: 'numeric_9', currency: 'EUR', invoice: false, provisional: true,
      latestUsageDay: services.map(row => row.latestUsageDay).sort().at(-1),
      period: { from: month + '-01', toExclusive: nextMonth < cutoff ? nextMonth : cutoff }, ...totals, services }, month));
  }
  return { advertisers, snapshots };
}

async function persistSnapshots({ model, snapshots, transaction }) {
  if (!transaction) fail('google_cost_transaction_required');
  const written = [], preserved = [];
  for (const raw of [...snapshots].sort((a, b) => a.month.localeCompare(b.month))) {
    const snapshot = projectSnapshot(raw, raw.month);
    const cache_key = keyFor(snapshot.month);
    const previous = await model.findByPk(cache_key, { transaction, lock: transaction.LOCK.UPDATE, raw: true });
    if (previous) {
      const old = projectSnapshot(previous.snapshot, snapshot.month);
      const coverage = old.latestUsageDay || new Date(Date.parse(old.period.toExclusive) - 86400000).toISOString().slice(0, 10);
      // Initial export backfill must not replace a newer/more complete report.
      if (old.collectedAt >= snapshot.collectedAt || coverage > snapshot.latestUsageDay) {
        preserved.push(snapshot.month); continue;
      }
    }
    await model.upsert({ cache_key, snapshot, collected_at: new Date(snapshot.collectedAt) }, { transaction });
    written.push(snapshot.month);
  }
  return { status: snapshots.length ? 'collected' : 'awaiting_export', written, preserved };
}

module.exports = { VIEW, cutoffForRun, combinedQuery, splitRows, persistSnapshots };
