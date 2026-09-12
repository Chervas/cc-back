#!/usr/bin/env node
'use strict';

// Operator-only cache repair. Importing this module never loads credentials or starts the application.
const { isDeepStrictEqual } = require('node:util');
const { buildAdQuery, readAdPages, daysBetween, normalizeAd, persistAdSnapshot } = require('../services/googleAdCache.service');
const { googleAdDeliveryObservation } = require('../services/googleAdDelivery.service');

const CUSTOMER = '1851215478';
const AUTHORIZATION = '--authorized-account-1851215478-ad-cache-write';
const ACCOUNT_QUERY = 'SELECT customer.id, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1';
const FLAGS = ['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER', 'SYSTEM_NOTIFICATIONS_CRON_LEADER',
  'AUTOMATIONS_V2_RESUME_FROM_SOCKET_BUS', 'CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED',
  'CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED', 'CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED',
  'CAMPAIGN_WORKSPACE_DESTINATION_REFRESH_ENABLED', 'CAMPAIGN_WORKSPACE_META_DESTINATION_REFRESH_ENABLED'];

function fail(code) { throw Object.assign(Error(code), { code }); }
function authorize(args) { if (args.length !== 1 || args[0] !== AUTHORIZATION) fail('EXPLICIT_AD_CACHE_WRITE_AUTHORIZATION_REQUIRED'); }
function hasAdsScope(value) {
  let scopes = value;
  if (typeof scopes === 'string') {
    try { scopes = JSON.parse(scopes); } catch { scopes = scopes.split(/[\s,]+/); }
  }
  return Array.isArray(scopes) && scopes.includes('https://www.googleapis.com/auth/adwords');
}
function assertAccount(account) {
  if (account?.id !== 11 || account.customerId !== CUSTOMER || account.assignmentScope !== 'group'
    || account.grupoClinicaId !== 5 || ![true, 1].includes(account.isActive)) fail('ACCOUNT_SCOPE_CHANGED');
}
function periodAt(now) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(now);
  const shift = days => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return { start: shift(-60), end: shift(-1), timeZone: 'Europe/Madrid' };
}
function queriesFor(period) {
  const days = daysBetween(period.start, period.end);
  const metrics = [];
  for (let i = 0; i < days.length; i += 31) metrics.push(buildAdQuery({ start: days[i], end: days[Math.min(i + 30, days.length - 1)] }));
  return { inventory: buildAdQuery({ inventory: true }), metrics,
    campaigns: `SELECT customer.id, campaign.id, campaign.advertising_channel_type, segments.date, metrics.cost_micros FROM campaign WHERE segments.date BETWEEN '${period.start}' AND '${period.end}'` };
}
function micros(value) {
  if (value === undefined) return 0n;
  if (!['number', 'string', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))
    || typeof value === 'number' && !Number.isSafeInteger(value)) fail('INVALID_COST_MICROS');
  return BigInt(value);
}
function adKey(row) { return [row.campaignId, row.adGroupId, row.adId].join(':'); }
function metricKey(row) { return JSON.stringify([row.campaignId, row.adGroupId, row.adId, row.date, row.network || '', row.device || '']); }
function metricIdentity(row, account) {
  const segments = row.segments || {};
  return { ...normalizeAd(row, account), date: segments.date,
    network: segments.adNetworkType || segments.ad_network_type || '', device: segments.device || '' };
}
function reconcileSearch({ campaignRows, metricRows, account, period }) {
  const days = new Set(daysBetween(period.start, period.end)); const campaigns = new Map(); const ads = new Map();
  for (const row of campaignRows) {
    const id = row.campaign?.id; const day = row.segments?.date;
    if (row.customer?.id !== CUSTOMER || !/^[1-9]\d*$/.test(id || '') || !days.has(day)
      || !row.campaign.advertisingChannelType) fail('CAMPAIGN_RECONCILIATION_INVALID_ROW');
    const key = `${id}:${day}`;
    if (campaigns.has(key)) fail('CAMPAIGN_RECONCILIATION_DUPLICATE');
    campaigns.set(key, { channel: row.campaign.advertisingChannelType, cost: micros(row.metrics?.costMicros) });
  }
  for (const row of metricRows) {
    const item = metricIdentity(row, account); const key = `${item.campaignId}:${item.date}`;
    if (!days.has(item.date)) fail('AD_DATE_OUTSIDE_WINDOW');
    ads.set(key, (ads.get(key) || 0n) + micros(row.metrics?.costMicros));
  }
  let checkedDays = 0; let campaignCost = 0n; let adCost = 0n;
  for (const [key, campaign] of campaigns) {
    if (campaign.channel !== 'SEARCH') continue; // PMax is not an ad_group_ad inventory.
    const cost = ads.get(key) || 0n; const difference = campaign.cost - cost;
    if (difference > 10000n || difference < -10000n) fail('SEARCH_DAILY_SPEND_MISMATCH');
    checkedDays++; campaignCost += campaign.cost; adCost += cost;
  }
  if (!checkedDays || [...ads].some(([key, cost]) => cost > 0n && !campaigns.has(key))) fail('CAMPAIGN_RECONCILIATION_INCOMPLETE');
  return { checkedDays, campaignCostMicros: String(campaignCost), adCostMicros: String(adCost), toleranceMicrosPerDay: '10000' };
}

async function verifyReplacement({ models, account, inventoryRows, metricRows, period, observedAt, scopes, transaction }) {
  const expected = new Map(inventoryRows.map(row => { const ad = normalizeAd(row, account);
    return [adKey(ad), { ...ad, deliveryObservation: googleAdDeliveryObservation(row.adGroupAd || row.ad_group_ad || {}, observedAt) }]; }));
  const inventory = await models.GoogleAdsAdInventory.findAll({ where: scopes.inventoryWhere, raw: true, transaction });
  const seen = new Set();
  for (const row of inventory) {
    const key = adKey(row); const wanted = expected.get(key);
    if (seen.has(key) || +new Date(row.observedAt) !== +observedAt || Boolean(row.present) !== Boolean(wanted)) fail('AD_INVENTORY_VERIFICATION_FAILED');
    seen.add(key);
    if (wanted && Object.entries(wanted).some(([field, value]) => !isDeepStrictEqual(row[field], value))) fail('AD_INVENTORY_VERIFICATION_FAILED');
  }
  if ([...expected.keys()].some(key => !seen.has(key))) fail('AD_INVENTORY_VERIFICATION_FAILED');
  const expectedMetrics = new Map(metricRows.map(row => [metricKey(metricIdentity(row, account)), row.metrics || {}]));
  const actual = await models.GoogleAdsAdInsightsDaily.findAll({ where: scopes.metricWhere, raw: true, transaction });
  if (actual.length !== metricRows.length || expectedMetrics.size !== metricRows.length) fail('AD_METRICS_VERIFICATION_FAILED');
  for (const row of actual) {
    const wanted = expectedMetrics.get(metricKey(row));
    if (!wanted || +new Date(row.observedAt) !== +observedAt || micros(row.costMicros) !== micros(wanted.costMicros)
      || ['impressions', 'clicks'].some(field => micros(row[field]) !== micros(wanted[field]))
      // Conversions use DECIMAL(18,6); Google may return more fractional digits.
      || Math.abs(Number(row.conversions) - Number(wanted.conversions || 0)) > 0.000000500001) fail('AD_METRICS_VERIFICATION_FAILED');
    expectedMetrics.delete(metricKey(row));
  }
  const coverage = await models.GoogleAdsAdSyncDay.findAll({ where: scopes.coverageWhere, raw: true, transaction });
  const days = daysBetween(period.start, period.end);
  if (coverage.length !== days.length || new Set(coverage.map(row => row.date)).size !== days.length
    || coverage.some(row => !days.includes(row.date) || +new Date(row.observedAt) !== +observedAt)) fail('AD_COVERAGE_VERIFICATION_FAILED');
  return { inventoryRows: inventory.length, presentAds: expected.size, metricRows: actual.length, completeDays: coverage.length };
}

async function repair({ models, account, request, guard, backup, now = () => new Date() }) {
  assertAccount(account);
  if (typeof guard !== 'function' || typeof backup !== 'function') fail('REPAIR_GUARDS_REQUIRED');
  await guard();
  const schema = await models.sequelize.getQueryInterface().describeTable('GoogleAdsAdInventory');
  if (schema.deliveryObservation?.type?.toUpperCase() !== 'JSON' || schema.deliveryObservation.allowNull !== true) fail('AD_DELIVERY_MIGRATION_REQUIRED');
  const observedAt = now(); const period = periodAt(observedAt); const queries = queriesFor(period);
  const read = query => readAdPages({ account, request, query });
  const identity = await read(ACCOUNT_QUERY);
  if (identity.length !== 1 || identity[0].customer?.id !== CUSTOMER || identity[0].customer.manager
    || identity[0].customer.currencyCode !== 'EUR' || identity[0].customer.timeZone !== period.timeZone) fail('GOOGLE_ACCOUNT_IDENTITY_CHANGED');
  const inventoryRows = await read(queries.inventory);
  if (!inventoryRows.length) fail('UNEXPECTED_EMPTY_AD_INVENTORY');
  const metricRows = [];
  for (const query of queries.metrics) metricRows.push(...await read(query));
  if (metricRows.length > 100000) fail('REPAIR_ROW_LIMIT');
  const reconciliation = reconcileSearch({ campaignRows: await read(queries.campaigns), metricRows, account, period });
  let scopes; let verification; let backupEvidence;
  const check = async transaction => {
    if (+now() - +observedAt > 300000 || +now() < +observedAt) fail('REPAIR_SNAPSHOT_EXPIRED');
    await guard(transaction);
  };
  const persisted = await persistAdSnapshot({ models, account, inventoryRows, metricRows, ...period, observedAt,
    beforeReplace: async options => {
      await check(options.transaction); scopes = options;
      const rows = {};
      for (const [key, model, where] of [['inventory', models.GoogleAdsAdInventory, options.inventoryWhere],
        ['metrics', models.GoogleAdsAdInsightsDaily, options.metricWhere], ['coverage', models.GoogleAdsAdSyncDay, options.coverageWhere]]) {
        rows[key] = await model.findAll({ where, limit: 100001, order: [['id', 'ASC']], raw: true, transaction: options.transaction });
        if (rows[key].length > 100000) fail('BACKUP_ROW_LIMIT');
      }
      backupEvidence = await backup({ customerId: CUSTOMER, mappingId: account.id, period, observedAt, rows });
    },
    afterReplace: async ({ transaction }) => {
      verification = await verifyReplacement({ models, account, inventoryRows, metricRows, period, observedAt, scopes, transaction });
      await check(transaction);
    },
  });
  if (persisted.skipped) fail('NEWER_AD_SNAPSHOT_ALREADY_PRESENT');
  return { customerId: CUSTOMER, mappingId: account.id, period, observedAt, persisted, reconciliation, verification, backup: backupEvidence };
}

function createReadOnlyRequest({ accessToken, expiresAt, developerToken, loginCustomerId, period, guard, requests,
  fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const queries = queriesFor(period); const allowed = new Set([ACCOUNT_QUERY, queries.inventory, ...queries.metrics, queries.campaigns]);
  return async (method, route, options) => {
    if (method !== 'POST' || route !== `customers/${CUSTOMER}/googleAds:search` || !allowed.has(options?.data?.query)
      || Object.keys(options.data).some(key => !['query', 'pageToken'].includes(key))) fail('NON_APPROVED_GOOGLE_READ');
    if (requests.length >= 24) fail('REPAIR_REQUEST_LIMIT');
    if (!Number.isFinite(+new Date(expiresAt)) || +new Date(expiresAt) < +now() + 30000) fail('TOKEN_EXPIRED_NO_REFRESH_ATTEMPTED');
    await guard();
    const entry = { at: now().toISOString(), page: Boolean(options.data.pageToken) }; requests.push(entry);
    const response = await fetchImpl(`https://googleads.googleapis.com/v24/customers/${CUSTOMER}/googleAds:search`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { authorization: `Bearer ${accessToken}`, 'developer-token': developerToken,
        'login-customer-id': loginCustomerId, 'content-type': 'application/json' }, body: JSON.stringify(options.data),
    });
    entry.status = response.status; entry.requestId = response.headers.get('request-id');
    if (!response.ok) fail('GOOGLE_READ_REJECTED');
    const body = await response.json();
    if (body?.error || body?.errors || body?.partialFailureError || body?.partial_failure_error) fail('GOOGLE_READ_INCOMPLETE');
    if (Array.isArray(body?.results) && body.results.length > 10000) fail('REPAIR_RESPONSE_ROW_LIMIT');
    return body;
  };
}

function saveJson(directory, name, value) {
  const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
  if (!['before.json', 'result.json'].includes(name)) fail('INVALID_EVIDENCE_FILE');
  const file = path.join(directory, name); const bytes = Buffer.from(JSON.stringify(value, null, 2));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) fail('BACKUP_HASH_MISMATCH');
  return { file: name, sha256 };
}

async function main(args) {
  authorize(args);
  const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
  const root = path.resolve(__dirname, '../..');
  const { Sequelize, DataTypes, QueryTypes } = require('sequelize');
  const runtime = () => {
    const entry = JSON.parse(cp.execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
      .find(row => row.name === 'pm2-back-dev');
    if (!entry || entry.pm2_env.status !== 'online' || entry.pm2_env.pm_cwd !== root
      || !FLAGS.every(key => entry.pm2_env[key] === 'false')) fail('INCIDENT_GATES_CHANGED');
    return entry.pm2_env;
  };
  const env = { ...require('dotenv').parse(fs.readFileSync(path.join(root, '.env'))), ...runtime() };
  const directory = fs.mkdtempSync(`/home/ubuntu/qa-evidence/propdental-ad-cache-apply-${new Date().toISOString().replace(/[:.]/g, '-')}-`);
  fs.chmodSync(directory, 0o700);
  const result = { startedAt: new Date().toISOString(), customerId: CUSTOMER, completed: false, requests: [], writeState: 'not_started',
    changes: 'Only GoogleAdsAdInventory, GoogleAdsAdInsightsDaily and GoogleAdsAdSyncDay for mapping 11/customer 1851215478; no migration, OAuth, Meta, jobs or provider mutations' };
  let sql;
  try {
    sql = new Sequelize(env.DB_NAME, env.DB_USERNAME, env.DB_PASSWORD, { host: env.DB_HOST, dialect: 'mysql', logging: false,
      timezone: '+00:00', pool: { min: 0, max: 2 }, retry: { max: 0 } });
    const models = { sequelize: sql };
    for (const file of ['clinicgoogleadsaccount', 'googleconnectionassignment', 'externalcampaignassignment',
      'googleadsadinventory', 'googleadsadinsightsdaily', 'googleadsadsyncday']) {
      const model = require(path.join(root, 'models', file))(sql, DataTypes); models[model.name] = model;
    }
    models.Clinica = sql.define('RepairClinicScope', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true }, grupoClinicaId: DataTypes.INTEGER },
      { tableName: 'Clinicas', timestamps: false });
    const account = await models.ClinicGoogleAdsAccount.findByPk(11, { raw: true }); assertAccount(account);
    const guard = async transaction => {
      runtime();
      const current = await models.ClinicGoogleAdsAccount.findByPk(11, { raw: true, transaction }); assertAccount(current);
      if (current.googleConnectionId !== account.googleConnectionId) fail('ACCOUNT_GRANT_CHANGED');
      const jobs = await sql.query("SELECT id FROM JobRequests WHERE type IN ('google_ads_recent','google_ads_backfill') AND status IN ('queued','running') LIMIT 1",
        { type: QueryTypes.SELECT, transaction });
      if (jobs.length) fail('GOOGLE_SYNC_CURRENTLY_RUNNING');
      const grants = await models.GoogleConnectionAssignment.findAll({ where: { assignmentScope: 'group', grupoClinicaId: 5 }, raw: true, transaction });
      if (grants.length !== 1 || grants[0].status !== 'active' || grants[0].googleConnectionId !== account.googleConnectionId) fail('ACCOUNT_GRANT_CHANGED');
      const usage = await sql.query("SELECT pause_until AS pauseUntil,usage_pct AS usagePct,DATE_FORMAT(usage_date,'%Y-%m-%d') AS usageDate FROM ApiUsageCounters WHERE provider='google_ads'",
        { type: QueryTypes.SELECT, transaction });
      const today = new Date().toISOString().slice(0, 10);
      if (usage.some(row => +new Date(row.pauseUntil || 0) > Date.now()
        || String(row.usageDate).slice(0, 10) === today && Number(row.usagePct) >= 90)) fail('EXISTING_PROVIDER_QUOTA_PAUSE');
    };
    await guard();
    const connections = await sql.query('SELECT accessToken,expiresAt,scopes FROM GoogleConnections WHERE id=?',
      { replacements: [account.googleConnectionId], type: QueryTypes.SELECT });
    const connection = connections[0];
    const loginCustomerId = String(account.loginCustomerId || account.managerCustomerId || env.GOOGLE_ADS_MANAGER_ID || '').replace(/\D/g, '');
    if (!connection?.accessToken || !hasAdsScope(connection.scopes)
      || !env.GOOGLE_ADS_DEVELOPER_TOKEN || !/^\d{10}$/.test(loginCustomerId)) fail('ADS_CONFIG_MISSING');
    const request = createReadOnlyRequest({ ...connection, loginCustomerId, developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
      period: periodAt(new Date()), guard, requests: result.requests });
    result.repair = await repair({ models, account, request, guard, backup: async value => {
      const saved = saveJson(directory, 'before.json', value); result.backup = saved;
      result.writeState = 'transaction_attempted_unconfirmed'; return saved;
    } });
    result.writeState = 'committed_and_verified'; result.completed = true;
  } catch (error) {
    result.failure = /^[a-zA-Z][a-zA-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'AD_CACHE_REPAIR_FAILED';
    process.exitCode = 1;
  } finally {
    if (sql) try { await sql.close(); } catch { result.cleanupFailed = true; process.exitCode = 1; }
    result.finishedAt = new Date().toISOString(); saveJson(directory, 'result.json', result);
    console.log(JSON.stringify({ directory, completed: result.completed, failure: result.failure, writeState: result.writeState,
      verification: result.repair?.verification }));
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.code || 'AD_CACHE_REPAIR_FAILED'); process.exitCode = 1; });
module.exports = { CUSTOMER, AUTHORIZATION, ACCOUNT_QUERY, authorize, hasAdsScope, assertAccount, periodAt, queriesFor,
  reconcileSearch, verifyReplacement, repair, createReadOnlyRequest, saveJson };
