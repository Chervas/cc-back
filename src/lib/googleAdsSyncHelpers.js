'use strict';

const CAMPAIGN_LEVEL_SEGMENT = 'CAMPAIGN_TOTAL';

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
    '  metrics.conversions_value',
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
  const persistedMetricsRows = Number(stats?.persistedMetricsRows ?? stats?.rows ?? 0);
  const persistedInventoryRows = Number(stats?.persistedInventoryRows ?? 0);
  return persistedMetricsRows > 0 || persistedInventoryRows > 0;
}

module.exports = {
  CAMPAIGN_LEVEL_SEGMENT,
  buildCampaignLevelMetricsQuery,
  prepareCampaignLevelFallbackRows,
  shouldMarkGoogleAdsAccountSynced,
};
