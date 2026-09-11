'use strict';

const { Op } = require('sequelize');

const ID = /^[1-9]\d{0,63}$/;
const RESOURCE_FIELDS = ['customer.id', 'campaign.id', 'campaign.name', 'campaign.status', 'ad_group.id', 'ad_group.name',
  'ad_group.status', 'ad_group_ad.status', 'ad_group_ad.ad.id', 'ad_group_ad.ad.name', 'ad_group_ad.ad.type'];
const CREATIVE_FIELDS = ['ad_group_ad.ad.final_urls', 'ad_group_ad.ad.final_mobile_urls',
  'ad_group_ad.ad.responsive_search_ad.headlines', 'ad_group_ad.ad.responsive_search_ad.descriptions'];
const METRIC_FIELDS = ['segments.date', 'segments.ad_network_type', 'segments.device',
  'metrics.impressions', 'metrics.clicks', 'metrics.cost_micros', 'metrics.conversions'];

function fail(code) { throw Object.assign(new Error(code), { code }); }
function identifier(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('google_ad_cache_invalid_id');
  if (!ID.test(String(value ?? ''))) fail('google_ad_cache_invalid_id');
  return String(value);
}
function dateOnly(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '') || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString().slice(0, 10) !== text) fail('google_ad_cache_invalid_date');
  return text;
}
function daysBetween(start, end) {
  start = dateOnly(start); end = dateOnly(end);
  const size = (+new Date(end) - +new Date(start)) / 86400000 + 1;
  if (size < 1 || size > 370) fail('google_ad_cache_invalid_window');
  return Array.from({ length: size }, (_, i) => new Date(+new Date(start) + i * 86400000).toISOString().slice(0, 10));
}
function text(value, length) { return typeof value === 'string' ? value.trim().slice(0, length) || null : null; }
function assets(items) { return Array.isArray(items) ? [...new Set(items.map(item => text(item?.text, 1024)).filter(Boolean))] : []; }

function normalizeAd(row, account, campaignId = null) {
  const group = row.adGroup || row.ad_group || {};
  const groupAd = row.adGroupAd || row.ad_group_ad || {};
  const ad = groupAd.ad || {};
  const campaign = row.campaign || {};
  const identity = { clinicGoogleAdsAccountId: account.id, customerId: identifier(String(account.customerId).replace(/-/g, '')),
    campaignId: identifier(campaign.id), adGroupId: identifier(group.id), adId: identifier(ad.id) };
  if (identifier(row.customer?.id) !== identity.customerId) fail('google_ad_cache_scope_mismatch');
  if (campaignId && identity.campaignId !== campaignId) fail('google_ad_cache_scope_mismatch');
  const rsa = ad.responsiveSearchAd || ad.responsive_search_ad || {};
  const urls = ad.finalUrls || ad.final_urls || ad.finalMobileUrls || ad.final_mobile_urls || [];
  const finalUrl = text(Array.isArray(urls) ? urls.find(Boolean) : null, 1024);
  let displayUrl = null;
  try { const url = new URL(finalUrl); displayUrl = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 512); } catch { /* Optional preview. */ }
  return { ...identity, campaignName: text(campaign.name, 256), campaignStatus: text(campaign.status, 32),
    adGroupName: text(group.name, 256), adGroupStatus: text(group.status, 32), adName: text(ad.name, 256),
    adStatus: text(groupAd.status, 32), adType: text(ad.type, 64), finalUrl, displayUrl,
    headlines: assets(rsa.headlines), descriptions: assets(rsa.descriptions) };
}

function metric(value, integer = false) {
  if (value === undefined || value === null) return 0; // Protobuf omits zero-valued fields.
  const number = Number(value);
  if (!['number', 'string'].includes(typeof value) || !/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(value))
    || !Number.isFinite(number) || number < 0 || integer && !Number.isSafeInteger(number)) fail('google_ad_cache_invalid_metric');
  return number;
}

function buildAdQuery({ campaignId = null, start, end, inventory = false }) {
  if (campaignId !== null) identifier(campaignId);
  const fields = [...RESOURCE_FIELDS, ...(inventory ? CREATIVE_FIELDS : METRIC_FIELDS)];
  const conditions = ["ad_group_ad.status IN ('ENABLED', 'PAUSED', 'REMOVED')"];
  if (campaignId) conditions.push(`campaign.id = ${campaignId}`);
  if (!inventory) {
    daysBetween(start, end);
    conditions.push(`segments.date BETWEEN '${dateOnly(start)}' AND '${dateOnly(end)}'`);
  }
  return `SELECT ${fields.join(', ')} FROM ad_group_ad WHERE ${conditions.join(' AND ')}`;
}

async function readAdPages({ account, accessToken, loginCustomerId, query, request }) {
  const customerId = identifier(String(account.customerId).replace(/-/g, ''));
  const rows = []; const tokens = new Set(); let pageToken;
  do {
    const response = await request('POST', `customers/${customerId}/googleAds:search`, {
      accessToken, loginCustomerId, data: { query, ...(pageToken ? { pageToken } : {}) },
    });
    if (!response || typeof response !== 'object' || Array.isArray(response) || response.results !== undefined && !Array.isArray(response.results)) fail('google_ad_cache_invalid_response');
    rows.push(...(response.results || []));
    pageToken = response.nextPageToken || response.next_page_token;
    if (rows.length > 200000 || pageToken && (typeof pageToken !== 'string' || tokens.has(pageToken) || tokens.size >= 500)) fail('google_ad_cache_incomplete_pages');
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);
  return rows;
}

// HTTP completes before the transaction. A row lock and observation timestamps fence overlapping refreshes.
async function persistAdSnapshot({ models, account, inventoryRows, metricRows, start, end, campaignId = null, observedAt }) {
  const days = daysBetween(start, end);
  identifier(account.id);
  if (!Number.isFinite(+new Date(observedAt))) fail('google_ad_cache_invalid_observation');
  const identity = { clinicGoogleAdsAccountId: account.id, customerId: identifier(String(account.customerId).replace(/-/g, '')) };
  if (campaignId !== null) campaignId = identifier(campaignId);
  const scope = { ...identity, ...(campaignId ? { campaignId } : {}) };
  const seen = new Set();
  const inventory = inventoryRows.map(row => {
    const value = { ...normalizeAd(row, account, campaignId), present: true, observedAt };
    const key = `${value.campaignId}:${value.adGroupId}:${value.adId}`;
    if (seen.has(key)) fail('google_ad_cache_duplicate_inventory');
    seen.add(key); return value;
  });
  const byId = new Map(inventory.map(row => [`${row.campaignId}:${row.adGroupId}:${row.adId}`, row]));
  const metricKeys = new Set();
  const metrics = metricRows.map(row => {
    const ad = normalizeAd(row, account, campaignId);
    const cached = byId.get(`${ad.campaignId}:${ad.adGroupId}:${ad.adId}`) || ad;
    const segments = row.segments || {}; const values = row.metrics || {}; const date = dateOnly(segments.date);
    if (!days.includes(date)) fail('google_ad_cache_date_outside_window');
    const network = text(segments.adNetworkType || segments.ad_network_type, 64) || '';
    const device = text(segments.device, 64) || '';
    const key = JSON.stringify([ad.campaignId, ad.adGroupId, ad.adId, date, network, device]);
    if (metricKeys.has(key)) fail('google_ad_cache_duplicate_metrics');
    metricKeys.add(key);
    const { adGroupStatus, present, observedAt: ignored, ...fields } = cached;
    const impressions = metric(values.impressions, true); const clicks = metric(values.clicks, true);
    return { ...fields, date, network, device, impressions, clicks,
      costMicros: metric(values.costMicros ?? values.cost_micros, true), conversions: metric(values.conversions), ctr: impressions ? clicks / impressions : 0,
      clinicaId: null, grupoClinicaId: account.grupoClinicaId || null, observedAt, created_at: observedAt, updated_at: observedAt };
  });
  return models.sequelize.transaction(async transaction => {
    const current = await models.ClinicGoogleAdsAccount.findByPk(account.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!current?.isActive || String(current.customerId).replace(/-/g, '') !== identity.customerId
      || current.googleConnectionId !== account.googleConnectionId) fail('google_ad_cache_account_changed');
    const coverage = await models.GoogleAdsAdSyncDay.findAll({ where: { ...identity,
      ...(campaignId ? { campaignId: { [Op.in]: ['', campaignId] } } : {}) }, raw: true, transaction });
    const latestInventory = await models.GoogleAdsAdInventory.findOne({ where: scope, order: [['observedAt', 'DESC']], raw: true, transaction });
    if ([...coverage, latestInventory].filter(Boolean).some(row => +new Date(row.observedAt) > +new Date(observedAt))) {
      return { skipped: true, reason: 'newer_snapshot', inventoryRows: 0, metricRows: 0 };
    }
    const assignments = await models.ExternalCampaignAssignment.findAll({ where: { provider: 'google_ads',
      customer_id: identity.customerId, ...(campaignId ? { campaign_id: campaignId } : {}) }, raw: true, transaction });
    for (const row of metrics) {
      const decisions = assignments.filter(item => item.campaign_id === row.campaignId);
      row.clinicaId = decisions.length ? (decisions.length === 1 && decisions[0].status === 'active' ? decisions[0].clinica_id : null)
        : current.assignmentScope === 'clinic' ? current.clinicaId : null;
      row.grupoClinicaId = current.grupoClinicaId || null;
    }
    await models.GoogleAdsAdInventory.update({ present: false, observedAt }, { where: scope, transaction, silent: true });
    if (inventory.length) await models.GoogleAdsAdInventory.bulkCreate(inventory, { transaction,
      updateOnDuplicate: ['campaignName', 'campaignStatus', 'adGroupName', 'adGroupStatus', 'adName', 'adType', 'adStatus',
        'finalUrl', 'displayUrl', 'headlines', 'descriptions', 'present', 'observedAt', 'updated_at'] });
    await models.GoogleAdsAdInsightsDaily.destroy({ where: { ...scope, date: { [Op.in]: days } }, transaction });
    if (metrics.length) await models.GoogleAdsAdInsightsDaily.bulkCreate(metrics, { transaction });
    await models.GoogleAdsAdSyncDay.bulkCreate(days.map(date => ({ ...identity, campaignId: campaignId || '', date, observedAt })),
      { transaction, updateOnDuplicate: ['observedAt', 'updated_at'] });
    return { skipped: false, inventoryRows: inventory.length, metricRows: metrics.length, days: days.length };
  });
}

async function syncGoogleAdCache({ models, account, accessToken, loginCustomerId, start, end, campaignId = null,
  chunkDays = 7, ensureHistory = false, now = () => new Date(), request = require('../lib/googleAdsClient').googleAdsRequest }) {
  let days = daysBetween(start, end);
  if (ensureHistory && !campaignId) {
    const historyStart = new Date(+new Date(dateOnly(end)) - 59 * 86400000).toISOString().slice(0, 10);
    const history = daysBetween(historyStart, end);
    const complete = await models.GoogleAdsAdSyncDay.findAll({ where: { clinicGoogleAdsAccountId: account.id,
      customerId: identifier(String(account.customerId).replace(/-/g, '')), campaignId: '', date: { [Op.in]: history } },
      attributes: ['date'], raw: true });
    const completed = new Set(complete.map(row => row.date));
    const missing = history.find(date => !completed.has(date));
    if (missing && missing < dateOnly(start)) { start = missing; days = daysBetween(start, end); }
  }
  const observedAt = now();
  if (!Number.isInteger(chunkDays) || chunkDays < 1 || chunkDays > 31) fail('google_ad_cache_invalid_chunk');
  const read = query => readAdPages({ account, accessToken, loginCustomerId, request, query });
  const inventoryRows = await read(buildAdQuery({ campaignId, inventory: true }));
  const metricRows = [];
  for (let offset = 0; offset < days.length; offset += chunkDays) {
    metricRows.push(...await read(buildAdQuery({ campaignId, start: days[offset], end: days[Math.min(offset + chunkDays - 1, days.length - 1)] })));
    if (metricRows.length > 200000) fail('google_ad_cache_incomplete_pages');
  }
  return persistAdSnapshot({ models, account, inventoryRows, metricRows, start, end, campaignId, observedAt });
}

module.exports = { buildAdQuery, readAdPages, normalizeAd, daysBetween, persistAdSnapshot, syncGoogleAdCache };
