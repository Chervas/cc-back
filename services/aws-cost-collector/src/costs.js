'use strict';

// Shared pure collector contract. It never reads credentials, models or environment on import.
const { createHash } = require('node:crypto');
const METRIC = 'UnblendedCost';
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw Error('cost_period_invalid');
  return value;
}
function filterFor({ accountId, environment }) {
  if (!/^\d{12}$/.test(accountId) || !['dev', 'staging', 'prod'].includes(environment)) throw Error('cost_scope_invalid');
  return { And: [
    { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [accountId] } },
    { Tags: { Key: 'application', Values: ['clinicaclick'] } },
    { Tags: { Key: 'component', Values: ['integrations', 'audit'] } },
    { Tags: { Key: 'environment', Values: [environment] } },
  ] };
}
function amountToUnits(value) {
  if (typeof value !== 'string' || !/^-?\d{1,16}(?:\.\d{1,18})?$/.test(value)) throw Error('cost_amount_invalid');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (value.startsWith('-') ? -1n : 1n) * (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')));
}
function unitsToAmount(value) {
  const sign = value < 0 ? '-' : ''; const absolute = value < 0 ? -value : value;
  const fraction = String(absolute % (10n ** 18n)).padStart(18, '0').replace(/0+$/, '');
  return `${sign}${absolute / (10n ** 18n)}${fraction ? `.${fraction}` : ''}`;
}
async function collectCosts({ getCostAndUsage, accountId, environment, from, to, tagsVerified, now = () => new Date() }) {
  dateKey(from); dateKey(to);
  if (from >= to || (Date.parse(to) - Date.parse(from)) / 86400000 > 62) throw Error('cost_period_invalid');
  if (tagsVerified !== true) throw Error('cost_tags_unverified');
  const filter = filterFor({ accountId, environment });
  const base = { TimePeriod: { Start: from, End: to }, Granularity: 'DAILY', Metrics: [METRIC], Filter: filter,
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }, { Type: 'TAG', Key: 'component' }] };
  const seenTokens = new Set(); const groups = new Map(); const days = new Map();
  let next; let pages = 0; let currency; let total = 0n;
  do {
    if (++pages > 100) throw Error('cost_pagination_limit');
    const response = await getCostAndUsage({ ...base, ...(next ? { NextPageToken: next } : {}) });
    if (!Array.isArray(response.ResultsByTime)) throw Error('cost_response_invalid');
    for (const day of response.ResultsByTime) {
      const start = dateKey(day.TimePeriod?.Start); const end = dateKey(day.TimePeriod?.End);
      if (start < from || end > to || Date.parse(end) - Date.parse(start) !== 86400000 || !Array.isArray(day.Groups) || typeof day.Estimated !== 'boolean') throw Error('cost_response_invalid');
      days.set(start, Boolean(days.get(start)) || day.Estimated);
      for (const group of day.Groups) {
        const [service, tag] = group.Keys || [];
        const component = typeof tag === 'string' && tag.startsWith('component$') ? tag.slice(10) : '';
        const money = group.Metrics?.[METRIC];
        if (!['integrations', 'audit'].includes(component) || typeof service !== 'string' || !service || service.length > 200
          || !/^[A-Z]{3}$/.test(money?.Unit)) throw Error('cost_response_invalid');
        if (currency && money.Unit !== currency) throw Error('cost_currency_mismatch');
        currency = money.Unit;
        const key = JSON.stringify([start, service, component]);
        if (groups.has(key)) throw Error('cost_duplicate_group');
        const amount = amountToUnits(money.Amount); total += amount;
        groups.set(key, { date: start, service, component, amount: unitsToAmount(amount), currency });
      }
    }
    next = response.NextPageToken;
    if (next !== undefined && (typeof next !== 'string' || !next || seenTokens.has(next))) throw Error('cost_pagination_invalid');
    if (next) seenTokens.add(next);
  } while (next);
  const allDays = [];
  for (let value = Date.parse(from); value < Date.parse(to); value += 86400000) allDays.push(new Date(value).toISOString().slice(0, 10));
  const missingDays = allDays.filter(day => !days.has(day));
  return { version: 1, source: 'aws_cost_explorer', metric: METRIC, environment,
    period: { from, toExclusive: to }, collectedAt: now().toISOString(),
    status: !currency || missingDays.length ? 'pending' : 'available', currency: currency || null,
    amount: currency && !missingDays.length ? unitsToAmount(total) : null,
    estimated: [...days.values()].some(Boolean), rows: [...groups.values()], missingDays,
    scope: { components: ['integrations', 'audit'], application: 'clinicaclick', environment },
    filterDigest: createHash('sha256').update(JSON.stringify(filter)).digest('hex'), pages,
    coverage: 'tagged_resources_only', excludesAiEstimates: true,
  };
}
function viewCache(record, { now = new Date(), staleAfterMs = 36 * 60 * 60 * 1000 } = {}) {
  if (!record?.snapshot) return { status: 'pending', snapshot: null, lastAttemptAt: record?.lastAttemptAt || null, error: record?.error || null };
  if (record.snapshot.status === 'pending') return { status: 'pending', snapshot: record.snapshot,
    lastAttemptAt: record.lastAttemptAt || null, error: record.error || null };
  const age = now.getTime() - Date.parse(record.snapshot.collectedAt);
  return { status: record.error || !Number.isFinite(age) || age < 0 || age > staleAfterMs ? 'stale' : record.snapshot.status,
    snapshot: record.snapshot, lastAttemptAt: record.lastAttemptAt || null, error: record.error || null };
}
module.exports = { collectCosts, filterFor, amountToUnits, unitsToAmount, viewCache };
