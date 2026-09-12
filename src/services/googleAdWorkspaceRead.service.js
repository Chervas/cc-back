'use strict';

const { Op } = require('sequelize');
const { googleAdDeliveryStatus } = require('./googleAdDelivery.service');
const key = row => JSON.stringify([row.customerId, row.campaignId, row.adGroupId, row.adId]);
const dayKey = (row, date = row.date) => JSON.stringify([key(row), date]);

async function loadGoogleWorkspaceAds({ models, googleWhere, dateWhere }) {
  const inventoryQuery = { where: { [Op.or]: googleWhere },
    attributes: ['clinicGoogleAdsAccountId', 'customerId', 'campaignId', 'campaignStatus', 'adGroupId', 'adGroupName', 'adGroupStatus',
      'adId', 'adName', 'headlines', 'adStatus', 'deliveryObservation', 'present', 'observedAt'], order: [['observedAt', 'DESC']], raw: true };
  let inventory;
  try { inventory = await models.GoogleAdsAdInventory.findAll(inventoryQuery); }
  catch (error) {
    const sqlError = error.original || error.parent || error;
    if (sqlError.code !== 'ER_BAD_FIELD_ERROR'
      || !/^Unknown column '(?:GoogleAdsAdInventory\.)?deliveryObservation' in 'field list'$/.test(sqlError.sqlMessage || '')) throw error;
    // A staged schema upgrade must not hide saved metrics or imply approval from ENABLED alone.
    inventory = await models.GoogleAdsAdInventory.findAll({ ...inventoryQuery,
      attributes: inventoryQuery.attributes.filter(field => field !== 'deliveryObservation') });
  }
  const rows = await models.GoogleAdsAdInsightsDaily.findAll({ where: { [Op.or]: googleWhere, date: dateWhere },
    attributes: ['clinicGoogleAdsAccountId', 'customerId', 'campaignId', 'adGroupId', 'adGroupName', 'adId', 'adName',
      'adStatus', 'date', 'network', 'device', 'costMicros', 'conversions', 'observedAt', 'updated_at'], order: [['observedAt', 'DESC'], ['updated_at', 'DESC']], raw: true });
  const coverage = await models.GoogleAdsAdSyncDay.findAll({ where: { date: dateWhere, [Op.or]: googleWhere.map(row => ({
    customerId: row.customerId, campaignId: { [Op.in]: ['', row.campaignId] },
  })) }, attributes: ['customerId', 'campaignId', 'date', 'observedAt'], order: [['observedAt', 'DESC']], raw: true });
  const byId = new Map();
  for (const row of inventory) if (!byId.has(key(row))) byId.set(key(row), row);
  const completed = new Map();
  for (const scope of googleWhere) {
    for (const row of coverage) {
      if (row.customerId !== scope.customerId || row.campaignId && row.campaignId !== scope.campaignId) continue;
      const identity = JSON.stringify([scope.customerId, scope.campaignId, row.date]);
      if (!completed.has(identity)) completed.set(identity, { ...row, campaignId: scope.campaignId });
    }
  }
  function identity(row) {
    const item = byId.get(key(row)) || row;
    const status = googleAdDeliveryStatus(item);
    return { provider: 'google_ads', account_id: row.customerId, campaign_id: row.campaignId, id: row.adId,
      groupId: row.adGroupId, groupName: item.adGroupName, title: item.adName || (Array.isArray(item.headlines) ? item.headlines[0] : null), status,
      updatedAt: item.observedAt || row.updated_at };
  }
  const ads = [...byId.values()].map(row => ({ ...identity(row), inventory: true }));
  const populated = new Set();
  for (const row of rows) {
    const checked = completed.get(JSON.stringify([row.customerId, row.campaignId, row.date]));
    // A newer complete response also supersedes stale rows kept by a duplicate account mapping.
    if (checked && +new Date(checked.observedAt) > +new Date(row.observedAt || row.updated_at)) continue;
    populated.add(dayKey(row));
    ads.push({ ...identity(row), date: row.date, segment: [row.network || '', row.device || ''],
      spend: Number(row.costMicros) / 1e6, providerConversions: Number(row.conversions), metricsUpdatedAt: row.observedAt || row.updated_at });
  }
  // Zero is inferred only from a complete provider response, never from inventory freshness alone.
  for (const row of byId.values()) for (const checked of completed.values()) {
    if (checked.customerId !== row.customerId || checked.campaignId !== row.campaignId
      || populated.has(dayKey(row, checked.date))) continue;
    populated.add(dayKey(row, checked.date));
    ads.push({ ...identity(row), date: checked.date, segment: ['COMPLETE_ZERO'], spend: 0, providerConversions: 0,
      metricsUpdatedAt: checked.observedAt });
  }
  return ads;
}

module.exports = { loadGoogleWorkspaceAds };
