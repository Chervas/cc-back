'use strict';

const CAMPAIGN_LEVEL_SEGMENT = 'CAMPAIGN_TOTAL';
const { formatDateLocal } = require('./availability-calendar');

function selectGoogleAdsSyncAccounts(accounts, options = {}) {
  const normalize = value => String(value ?? '').replace(/-/g, '');
  const filters = Object.fromEntries(['customerIds', 'clinicIds', 'groupIds'].map(key => {
    const values = options[key];
    if (values === undefined || Array.isArray(values) && !values.length) return [key, null];
    if (!Array.isArray(values) || values.some(value => !/^[1-9]\d*$/.test(key === 'customerIds' ? normalize(value) : String(value)))) {
      throw new Error(`google_ads_invalid_${key}`);
    }
    return [key, new Set(values.map(value => key === 'customerIds' ? normalize(value) : String(value)))];
  }));
  const eligible = accounts.filter(row => (!filters.customerIds || filters.customerIds.has(normalize(row.customerId)))
    && (!filters.clinicIds || filters.clinicIds.has(String(row.clinicaId ?? row.clinica?.id_clinica)))
    && (!filters.groupIds || filters.groupIds.has(String(row.grupoClinicaId ?? row.clinica?.grupoClinicaId))));
  const grouped = new Map();
  for (const row of eligible) { const key = normalize(row.customerId); const list = grouped.get(key) || []; list.push(row); grouped.set(key, list); }
  const selected = []; const errors = []; let duplicateMappings = 0;
  for (const [customerId, rows] of grouped) {
    const owners = accounts.filter(row => normalize(row.customerId) === customerId);
    // Filters choose the customer, not a second cache copy for each clinic.
    const first = owners.slice().sort((a, b) => Number(b.assignmentScope === 'group') - Number(a.assignmentScope === 'group') || a.id - b.id)[0];
    const sameOwner = row => row.googleConnectionId === first.googleConnectionId
      && (first.assignmentScope === 'group' ? row.grupoClinicaId === first.grupoClinicaId
        : row.assignmentScope === 'clinic' && row.clinicaId === first.clinicaId);
    if (!/^\d{10}$/.test(customerId) || owners.some(row => !sameOwner(row))) {
      errors.push({ customerId, error: 'google_ads_ambiguous_account_owner' }); continue;
    }
    duplicateMappings += rows.length - 1; selected.push(first);
  }
  return { accounts: selected, errors, duplicateMappings };
}

function googleAdsSyncWindow(options, account, defaultDays, now = new Date()) {
  const date = value => {
    if (value === undefined || value === null) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(+parsed) || typeof value !== 'string' && !(value instanceof Date)) throw new Error('google_ads_invalid_date');
    const day = parsed.toISOString().slice(0, 10);
    if (typeof value === 'string' && !value.startsWith(day)) throw new Error('google_ads_invalid_date');
    return day;
  };
  const timeZone = account.timeZone || 'Europe/Madrid';
  const today = formatDateLocal(now, timeZone);
  const shift = (day, days) => new Date(+new Date(day) + days * 86400000).toISOString().slice(0, 10);
  const end = date(options.endDate) || shift(today, -1);
  const count = Number(options.windowDays ?? options.days ?? defaultDays);
  if (!Number.isInteger(count) || count < 1 || count > 370) throw new Error('google_ads_invalid_window');
  const start = date(options.startDate) || shift(end, -(count - 1));
  const days = (+new Date(end) - +new Date(start)) / 86400000 + 1;
  if (days < 1 || days > 370 || end >= today) throw new Error('google_ads_invalid_window');
  return { start, end, days, timeZone };
}

async function finishGoogleAdsSync(syncLog, report) {
  const failed = report.errors.length > 0;
  const status = failed ? report.processed > 0 ? 'completed_with_errors' : 'failed' : 'completed';
  const result = { ...report, status, syncLogId: syncLog.id, ...(failed ? { partial: report.processed > 0 } : {}) };
  await syncLog.update({ status: failed ? 'failed' : 'completed', end_time: new Date(), records_processed: report.processed,
    status_report: result, error_message: failed ? `${report.errors.length} cuenta(s) sin sincronizacion completa` : null });
  return result;
}

async function updateGoogleAdsSyncMetadata(model, account, patch) {
  const fields = ['id', 'customerId', 'googleConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId'];
  const where = Object.fromEntries(fields.map(key => [key, account[key] ?? null]));
  const [count] = await model.update(patch, { where: { ...where, isActive: true } });
  if (count !== 1) throw new Error('google_ads_account_changed');
}

function buildCampaignLevelMetricsQuery(startDate, endDate) {
  return [
    'SELECT',
    '  campaign.id,',
    '  campaign.name,',
    '  campaign.status,',
    '  campaign.serving_status,',
    '  campaign.primary_status,',
    '  campaign.primary_status_reasons,',
    '  campaign.advertising_channel_type,',
    '  segments.date,',
    '  metrics.impressions,',
    '  metrics.clicks,',
    '  metrics.cost_micros,',
    '  metrics.conversions,',
    '  metrics.conversions_value,',
    '  metrics.all_conversions,',
    '  metrics.all_conversions_value',
    'FROM campaign',
    `WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`,
  ].join('\n');
}

function prepareCampaignLevelFallbackRows(results, processedCampaignDates) {
  const processed = processedCampaignDates instanceof Set
    ? processedCampaignDates
    : new Set();
  const prepared = [];

  for (const row of Array.isArray(results) ? results : []) {
    const campaignId = row?.campaign?.id ? String(row.campaign.id) : null;
    const date = row?.segments?.date;
    if (!campaignId || !date) continue;

    const key = `${campaignId}:${date}`;
    if (processed.has(key)) continue;
    processed.add(key);

    prepared.push({
      ...row,
      segments: {
        ...(row.segments || {}),
        date,
        adNetworkType: CAMPAIGN_LEVEL_SEGMENT,
        device: CAMPAIGN_LEVEL_SEGMENT,
      },
    });
  }

  return prepared;
}

function shouldMarkGoogleAdsAccountSynced(stats) {
  if (stats?.complete === true) return true;
  const persistedMetricsRows = Number(stats?.persistedMetricsRows ?? stats?.rows ?? 0);
  const persistedInventoryRows = Number(stats?.persistedInventoryRows ?? 0);
  return persistedMetricsRows > 0 || persistedInventoryRows > 0;
}

module.exports = {
  CAMPAIGN_LEVEL_SEGMENT,
  buildCampaignLevelMetricsQuery,
  prepareCampaignLevelFallbackRows,
  shouldMarkGoogleAdsAccountSynced,
  selectGoogleAdsSyncAccounts,
  googleAdsSyncWindow,
  finishGoogleAdsSync,
  updateGoogleAdsSyncMetadata,
};
