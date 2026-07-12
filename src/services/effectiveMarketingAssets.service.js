'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { metaGet } = require('../lib/metaClient');
const {
  normalizeScope,
  resolveMetaConnectionForScope,
  resolveGoogleConnectionForScope
} = require('./scopeConnectionResolver.service');

const IntakeConfig = db.IntakeConfig;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const ClinicMetaAsset = db.ClinicMetaAsset;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const MetaConnection = db.MetaConnection;

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function cleanString(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value || null;
}

function cleanGoogleCustomerId(raw) {
  const cleaned = String(raw || '').replace(/\D+/g, '');
  return cleaned || null;
}

function normalizeGoogleCampaignIds(...rawValues) {
  const seen = new Set();
  const normalized = [];
  for (const rawValue of rawValues) {
    const values = Array.isArray(rawValue) ? rawValue : rawValue == null ? [] : [rawValue];
    for (const value of values) {
      const campaignId = cleanGoogleCustomerId(value);
      if (!campaignId || seen.has(campaignId)) continue;
      seen.add(campaignId);
      normalized.push(campaignId);
    }
  }
  return normalized;
}

function normalizeMetaAdAccountId(raw) {
  const value = cleanString(raw);
  if (!value) return null;
  if (value.startsWith('act_')) return value;
  return /^\d+$/.test(value) ? `act_${value}` : value;
}

function extractGoogleTagId(sendTo) {
  const raw = cleanString(sendTo);
  if (!raw) return null;
  const match = raw.match(/(AW-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

function normalizeGoogleAdsDestinations(rawDestinations, fallbackCurrency = 'EUR') {
  if (!Array.isArray(rawDestinations)) return [];
  const normalized = [];
  const seenTargets = new Set();
  for (let index = 0; index < rawDestinations.length; index += 1) {
    const raw = rawDestinations[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const customerId = cleanGoogleCustomerId(raw.customer_id || raw.customerId) || null;
    const conversionAction = cleanString(raw.conversion_action || raw.conversionAction);
    const conversionActionId = cleanString(raw.conversion_action_id || raw.conversionActionId);
    const sendTo = cleanString(raw.send_to || raw.sendTo);
    const identity = [customerId, conversionAction, conversionActionId, sendTo].join('|');
    if (seenTargets.has(identity)) continue;
    seenTargets.add(identity);
    normalized.push({
      key: cleanString(raw.key || raw.destination_key || raw.destinationKey)
        || `destination_${customerId || index + 1}`,
      enabled: raw.enabled !== false,
      customer_id: customerId,
      conversion_action: conversionAction,
      conversion_action_id: conversionActionId,
      send_to: sendTo,
      currency: cleanString(raw.currency) || fallbackCurrency,
      campaign_ids: normalizeGoogleCampaignIds(raw.campaign_ids, raw.campaignIds),
      ...(raw.value !== undefined ? { value: raw.value } : {}),
      ...(raw.consent !== undefined ? { consent: raw.consent } : {})
    });
  }
  return normalized;
}

function normalizeMetaAdsConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      enabled: true,
      connection_id: null,
      ad_account_id: null,
      pixel_id: null
    };
  }

  return {
    enabled: rawConfig.enabled !== false,
    connection_id: parseInteger(rawConfig.connection_id || rawConfig.connectionId),
    ad_account_id: normalizeMetaAdAccountId(rawConfig.ad_account_id || rawConfig.adAccountId),
    pixel_id: cleanString(rawConfig.pixel_id || rawConfig.pixelId)
  };
}

function normalizeGoogleAdsConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      enabled: false,
      customer_id: null,
      conversion_action: null,
      conversion_action_id: null,
      send_to: null,
      currency: 'EUR',
      events: {}
    };
  }

  const normalized = {
    enabled: rawConfig.enabled !== false,
    customer_id: cleanGoogleCustomerId(rawConfig.customer_id || rawConfig.customerId) || null,
    conversion_action: cleanString(rawConfig.conversion_action || rawConfig.conversionAction),
    conversion_action_id: cleanString(rawConfig.conversion_action_id || rawConfig.conversionActionId),
    send_to: cleanString(rawConfig.send_to || rawConfig.sendTo),
    currency: cleanString(rawConfig.currency) || 'EUR',
    events: {}
  };

  const rawEvents = rawConfig.events && typeof rawConfig.events === 'object' && !Array.isArray(rawConfig.events)
    ? rawConfig.events
    : {};

  for (const [eventKey, eventValue] of Object.entries(rawEvents)) {
    if (!eventValue || typeof eventValue !== 'object' || Array.isArray(eventValue)) continue;
    const normalizedEvent = {
      enabled: eventValue.enabled !== false,
      customer_id: cleanGoogleCustomerId(eventValue.customer_id || eventValue.customerId) || null,
      conversion_action: cleanString(eventValue.conversion_action || eventValue.conversionAction),
      conversion_action_id: cleanString(eventValue.conversion_action_id || eventValue.conversionActionId),
      send_to: cleanString(eventValue.send_to || eventValue.sendTo),
      currency: cleanString(eventValue.currency) || normalized.currency
    };
    normalizedEvent.campaign_ids = normalizeGoogleCampaignIds(
      eventValue.campaign_ids,
      eventValue.campaignIds
    );
    if (Object.prototype.hasOwnProperty.call(eventValue, 'destinations')) {
      normalizedEvent.destinations = normalizeGoogleAdsDestinations(
        eventValue.destinations,
        cleanString(eventValue.currency) || normalized.currency
      );
    }
    normalized.events[eventKey] = normalizedEvent;
  }

  return normalized;
}

function hasMetaAdsConfig(rawConfig) {
  const normalized = normalizeMetaAdsConfig(rawConfig);
  return Boolean(normalized.connection_id || normalized.ad_account_id || normalized.pixel_id);
}

function hasGoogleAdsConfig(rawConfig) {
  const normalized = normalizeGoogleAdsConfig(rawConfig);
  if (normalized.customer_id || normalized.conversion_action || normalized.conversion_action_id || normalized.send_to) {
    return true;
  }
  return Object.values(normalized.events || {}).some((eventCfg) => (
    eventCfg?.customer_id || eventCfg?.conversion_action || eventCfg?.conversion_action_id || eventCfg?.send_to
      || (Array.isArray(eventCfg?.destinations) && eventCfg.destinations.length > 0)
  ));
}

function mergeGoogleAdsEvents(baseEvents = {}, overrideEvents = {}, rawOverrideEvents = {}) {
  const merged = { ...baseEvents };
  for (const [eventKey, overrideValue] of Object.entries(overrideEvents || {})) {
    const baseValue = merged[eventKey] && typeof merged[eventKey] === 'object' ? merged[eventKey] : {};
    const rawValue = rawOverrideEvents[eventKey] && typeof rawOverrideEvents[eventKey] === 'object'
      ? rawOverrideEvents[eventKey]
      : {};
    const pickEventValue = (snakeKey, camelKey, fallbackValue) => (
      Object.prototype.hasOwnProperty.call(rawValue, snakeKey)
        || (camelKey && Object.prototype.hasOwnProperty.call(rawValue, camelKey))
        ? overrideValue[snakeKey]
        : fallbackValue
    );
    const mergedEvent = {
      enabled: Object.prototype.hasOwnProperty.call(rawValue, 'enabled') ? overrideValue.enabled : baseValue.enabled,
      customer_id: pickEventValue('customer_id', 'customerId', baseValue.customer_id),
      conversion_action: pickEventValue('conversion_action', 'conversionAction', baseValue.conversion_action),
      conversion_action_id: pickEventValue('conversion_action_id', 'conversionActionId', baseValue.conversion_action_id),
      send_to: pickEventValue('send_to', 'sendTo', baseValue.send_to),
      currency: Object.prototype.hasOwnProperty.call(rawValue, 'currency') ? overrideValue.currency : baseValue.currency,
      campaign_ids: (
        Object.prototype.hasOwnProperty.call(rawValue, 'campaign_ids')
          || Object.prototype.hasOwnProperty.call(rawValue, 'campaignIds')
      ) ? overrideValue.campaign_ids : (baseValue.campaign_ids || [])
    };
    if (Object.prototype.hasOwnProperty.call(rawValue, 'destinations')) {
      mergedEvent.destinations = overrideValue.destinations;
    } else if (Object.prototype.hasOwnProperty.call(baseValue, 'destinations')) {
      mergedEvent.destinations = baseValue.destinations;
    }
    merged[eventKey] = mergedEvent;
  }
  return merged;
}

function mergeGoogleAdsConfig(baseConfig, overrideConfig) {
  const base = normalizeGoogleAdsConfig(baseConfig);
  const rawOverride = overrideConfig && typeof overrideConfig === 'object' && !Array.isArray(overrideConfig)
    ? overrideConfig
    : {};
  const override = normalizeGoogleAdsConfig(rawOverride);
  const pickOverride = (snakeKey, camelKey, normalizedValue, fallbackValue) => (
    Object.prototype.hasOwnProperty.call(rawOverride, snakeKey)
      || (camelKey && Object.prototype.hasOwnProperty.call(rawOverride, camelKey))
      ? normalizedValue
      : fallbackValue
  );
  return {
    enabled: Object.prototype.hasOwnProperty.call(rawOverride, 'enabled') ? override.enabled : base.enabled,
    customer_id: pickOverride('customer_id', 'customerId', override.customer_id, base.customer_id),
    conversion_action: pickOverride('conversion_action', 'conversionAction', override.conversion_action, base.conversion_action),
    conversion_action_id: pickOverride('conversion_action_id', 'conversionActionId', override.conversion_action_id, base.conversion_action_id),
    send_to: pickOverride('send_to', 'sendTo', override.send_to, base.send_to),
    currency: Object.prototype.hasOwnProperty.call(rawOverride, 'currency') ? override.currency : base.currency,
    events: mergeGoogleAdsEvents(base.events, override.events, rawOverride.events || {})
  };
}

function mergeMetaAdsConfig(baseConfig, overrideConfig) {
  const base = normalizeMetaAdsConfig(baseConfig);
  const override = normalizeMetaAdsConfig(overrideConfig);
  return {
    enabled: override.enabled !== undefined ? override.enabled : base.enabled,
    connection_id: override.connection_id || base.connection_id || null,
    ad_account_id: override.ad_account_id || base.ad_account_id || null,
    pixel_id: override.pixel_id || base.pixel_id || null
  };
}

function getScopeAssignmentScope(scope) {
  return String(scope?.assignment_scope || scope?.assignmentScope || '').trim().toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
}

function getScopeClinicId(scope) {
  return parseInteger(scope?.clinic_id ?? scope?.clinicId);
}

function getScopeGroupId(scope) {
  return parseInteger(scope?.group_id ?? scope?.groupId);
}

function getScopeClinicIds(scope) {
  const clinicIds = Array.isArray(scope?.clinic_ids)
    ? scope.clinic_ids
    : Array.isArray(scope?.clinicIds)
      ? scope.clinicIds
      : [];
  return clinicIds
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function buildScopedAssetWhere(scope) {
  const assignmentScope = getScopeAssignmentScope(scope);
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  const clinicIds = getScopeClinicIds(scope);

  if (assignmentScope === 'group') {
    const or = [];
    if (groupId) {
      or.push({ grupoClinicaId: groupId });
    }
    if (clinicIds.length > 0) {
      or.push({ clinicaId: { [Op.in]: clinicIds } });
    }
    return or.length > 0 ? { [Op.or]: or } : {};
  }

  const or = [];
  if (clinicId) {
    or.push({ clinicaId: clinicId });
  }
  if (groupId) {
    or.push({ grupoClinicaId: groupId, assignmentScope: 'group' });
  }
  return or.length > 0 ? { [Op.or]: or } : {};
}

function resolveAssetOrigin(row, scope) {
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  if (clinicId && parseInteger(row?.clinicaId) === clinicId) return 'clinic';
  if (groupId && parseInteger(row?.grupoClinicaId) === groupId) return 'group';
  return String(row?.assignmentScope || '').trim().toLowerCase() === 'group' ? 'group' : 'clinic';
}

function getOriginPriority(origin) {
  return origin === 'clinic' ? 0 : 1;
}

function sortRowsForSelection(scope, rows) {
  return [...rows].sort((left, right) => {
    const leftOrigin = resolveAssetOrigin(left, scope);
    const rightOrigin = resolveAssetOrigin(right, scope);
    const originDiff = getOriginPriority(leftOrigin) - getOriginPriority(rightOrigin);
    if (originDiff !== 0) return originDiff;
    const leftUpdated = new Date(left?.updatedAt || left?.updated_at || 0).getTime();
    const rightUpdated = new Date(right?.updatedAt || right?.updated_at || 0).getTime();
    return rightUpdated - leftUpdated;
  });
}

function dedupePreferred(scope, rows, keyBuilder) {
  const result = [];
  const seen = new Set();
  for (const row of sortRowsForSelection(scope, rows)) {
    const key = keyBuilder(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

async function loadScopeDescriptors(scope) {
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  const [clinic, group] = await Promise.all([
    clinicId
      ? Clinica.findOne({
        where: { id_clinica: clinicId },
        attributes: ['id_clinica', 'nombre_clinica'],
        raw: true
      })
      : null,
    groupId
      ? GrupoClinica.findOne({
        where: { id_grupo: groupId },
        attributes: ['id_grupo', 'nombre_grupo'],
        raw: true
      })
      : null
  ]);

  return {
    clinic_name: clinic?.nombre_clinica || null,
    group_name: group?.nombre_grupo || null
  };
}

async function loadScopeIntakeRecords(scope) {
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);

  const [clinicRecord, groupRecord] = await Promise.all([
    clinicId
      ? IntakeConfig.findOne({ where: { clinic_id: clinicId }, raw: true })
      : null,
    groupId
      ? IntakeConfig.findOne({ where: { group_id: groupId, assignment_scope: 'group' }, raw: true })
      : null
  ]);

  return {
    clinicRecord: clinicRecord || null,
    groupRecord: groupRecord || null
  };
}

function resolveEffectiveTrackingConfig(scope, records = {}) {
  const assignmentScope = getScopeAssignmentScope(scope);
  const clinicConfig = records?.clinicRecord?.config && typeof records.clinicRecord.config === 'object'
    ? records.clinicRecord.config
    : {};
  const groupConfig = records?.groupRecord?.config && typeof records.groupRecord.config === 'object'
    ? records.groupRecord.config
    : {};

  const groupGoogle = normalizeGoogleAdsConfig(groupConfig.google_ads);
  const clinicGoogle = normalizeGoogleAdsConfig(clinicConfig.google_ads);
  const effectiveGoogle = assignmentScope === 'group'
    ? groupGoogle
    : mergeGoogleAdsConfig(groupConfig.google_ads, clinicConfig.google_ads);
  const googleSource = assignmentScope === 'group'
    ? (hasGoogleAdsConfig(groupConfig.google_ads) ? 'group' : null)
    : hasGoogleAdsConfig(clinicConfig.google_ads)
      ? 'clinic'
      : hasGoogleAdsConfig(groupConfig.google_ads)
        ? 'group'
        : null;

  const groupMeta = normalizeMetaAdsConfig(groupConfig.meta_ads);
  const clinicMeta = normalizeMetaAdsConfig(clinicConfig.meta_ads);
  const effectiveMeta = assignmentScope === 'group'
    ? groupMeta
    : mergeMetaAdsConfig(groupMeta, clinicMeta);
  let metaSource = assignmentScope === 'group'
    ? (hasMetaAdsConfig(groupConfig.meta_ads) ? 'group' : null)
    : hasMetaAdsConfig(clinicConfig.meta_ads)
      ? 'clinic'
      : hasMetaAdsConfig(groupConfig.meta_ads)
        ? 'group'
        : null;

  const globalPixelId = cleanString(process.env.META_PIXEL_ID);
  const globalCapiToken = cleanString(process.env.META_CAPI_TOKEN);
  const effectivePixelId = effectiveMeta.pixel_id || globalPixelId || null;
  if (!metaSource && effectivePixelId) {
    metaSource = 'global';
  }

  return {
    google_ads: {
      ...effectiveGoogle,
      tag_id: extractGoogleTagId(effectiveGoogle.send_to),
      config_source: googleSource
    },
    meta_ads: {
      ...effectiveMeta,
      pixel_id: effectivePixelId,
      global_pixel_id: globalPixelId,
      has_global_capi_token: Boolean(globalCapiToken),
      config_source: metaSource
    }
  };
}

async function listScopedMetaAssets(scope) {
  const rows = await ClinicMetaAsset.findAll({
    where: {
      isActive: true,
      assetType: { [Op.in]: ['facebook_page', 'instagram_business', 'ad_account'] },
      ...buildScopedAssetWhere(scope)
    },
    order: [['updatedAt', 'DESC']],
    raw: true
  });

  const adAccounts = dedupePreferred(scope, rows.filter((row) => row.assetType === 'ad_account'), (row) => normalizeMetaAdAccountId(row.metaAssetId));
  const facebookPages = dedupePreferred(scope, rows.filter((row) => row.assetType === 'facebook_page'), (row) => cleanString(row.metaAssetId));
  const instagramAccounts = dedupePreferred(scope, rows.filter((row) => row.assetType === 'instagram_business'), (row) => cleanString(row.metaAssetId));

  return {
    ad_accounts: adAccounts.map((row) => ({
      ad_account_id: normalizeMetaAdAccountId(row.metaAssetId),
      name: row.metaAssetName || null,
      mapped_to_scope: true,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.metaConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId)
    })),
    facebook_pages: facebookPages.map((row) => ({
      page_id: cleanString(row.metaAssetId),
      name: row.metaAssetName || null,
      mapped_to_scope: true,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.metaConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId)
    })),
    instagram_business: instagramAccounts.map((row) => ({
      instagram_business_id: cleanString(row.metaAssetId),
      name: row.metaAssetName || null,
      mapped_to_scope: true,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.metaConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId)
    }))
  };
}

function pickEffectiveMetaAsset(metaAssets, metaConfig) {
  const effectiveAdAccount = metaConfig?.ad_account_id
    ? metaAssets.ad_accounts.find((item) => item.ad_account_id === metaConfig.ad_account_id) || null
    : metaAssets.ad_accounts[0] || null;

  const effectivePage = metaAssets.facebook_pages[0] || null;
  const effectiveInstagram = metaAssets.instagram_business[0] || null;

  return {
    ad_account: effectiveAdAccount,
    facebook_page: effectivePage,
    instagram_business: effectiveInstagram,
    pixel: {
      pixel_id: metaConfig?.pixel_id || null,
      assignment_origin: metaConfig?.config_source || null,
      connection_id: metaConfig?.connection_id || effectiveAdAccount?.connection_id || null
    }
  };
}

async function listScopedGoogleAccounts(scope) {
  const rows = await ClinicGoogleAdsAccount.findAll({
    where: {
      isActive: true,
      ...buildScopedAssetWhere(scope)
    },
    order: [['updated_at', 'DESC']],
    raw: true
  });

  const deduped = dedupePreferred(scope, rows, (row) => cleanGoogleCustomerId(row.customerId));
  return deduped.map((row) => {
    const customerId = cleanGoogleCustomerId(row.customerId);
    return {
      customer_id: customerId,
      formatted_customer_id: customerId
        ? `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6, 9)}`
        : null,
      descriptive_name: row.descriptiveName || null,
      currency_code: row.currencyCode || null,
      time_zone: row.timeZone || null,
      is_linked: row.managerLinkStatus === 'ACTIVE',
      manager_link_status: row.managerLinkStatus || null,
      mapped_to_scope: true,
      login_customer_id: cleanGoogleCustomerId(row.loginCustomerId || row.managerCustomerId) || null,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.googleConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId)
    };
  });
}

function pickEffectiveGoogleAccount(googleAccounts, googleConfig) {
  const selected = googleConfig?.customer_id
    ? googleAccounts.find((item) => item.customer_id === googleConfig.customer_id) || null
    : googleAccounts[0] || null;

  return {
    account: selected,
    tag_id: extractGoogleTagId(googleConfig?.send_to)
  };
}

async function listMetaPixelsForScopeAdAccount({ scope, adAccountId, connectionId = null }) {
  const normalizedAccountId = normalizeMetaAdAccountId(adAccountId);
  if (!normalizedAccountId) return [];

  let resolvedConnectionId = parseInteger(connectionId);
  if (!resolvedConnectionId) {
    const metaAssets = await listScopedMetaAssets(scope);
    const matchingAccount = metaAssets.ad_accounts.find((item) => item.ad_account_id === normalizedAccountId) || null;
    resolvedConnectionId = matchingAccount?.connection_id || null;
  }

  if (!resolvedConnectionId) {
    return [];
  }

  const connection = await MetaConnection.findByPk(resolvedConnectionId, {
    attributes: ['id', 'accessToken'],
    raw: true
  });
  if (!connection?.accessToken) {
    return [];
  }

  const response = await metaGet(`${normalizedAccountId}/adspixels`, {
    accessToken: connection.accessToken,
    params: {
      fields: 'id,name,creation_time,business{id,name},is_created_by_business',
      limit: 200
    },
    timeout: 15000
  });

  const rows = Array.isArray(response?.data?.data) ? response.data.data : [];
  return rows.map((row) => ({
    pixel_id: cleanString(row.id),
    name: row.name || null,
    creation_time: row.creation_time || null,
    business_id: cleanString(row?.business?.id),
    business_name: row?.business?.name || null,
    is_created_by_business: row?.is_created_by_business === true
  }));
}

async function resolveEffectiveMarketingState({ clinicIdRaw = null, groupIdRaw = null, assignmentScopeRaw = null }) {
  const normalizedScope = await normalizeScope({ clinicIdRaw, groupIdRaw, assignmentScopeRaw });
  const scope = {
    assignment_scope: normalizedScope.assignmentScope,
    clinic_id: normalizedScope.clinicId,
    group_id: normalizedScope.groupId,
    clinic_ids: normalizedScope.groupId
      ? ((await Clinica.findAll({
        where: { grupoClinicaId: normalizedScope.groupId },
        attributes: ['id_clinica'],
        raw: true
      })).map((row) => parseInteger(row.id_clinica)).filter(Boolean))
      : (normalizedScope.clinicId ? [normalizedScope.clinicId] : [])
  };

  const [descriptors, records, metaConnectionResolution, googleConnectionResolution, metaAssets, googleAccounts] = await Promise.all([
    loadScopeDescriptors(scope),
    loadScopeIntakeRecords(scope),
    resolveMetaConnectionForScope({
      clinicIdRaw: scope.clinic_id,
      groupIdRaw: scope.group_id,
      assignmentScopeRaw: scope.assignment_scope,
      allowLegacyUserFallback: true
    }),
    resolveGoogleConnectionForScope({
      clinicIdRaw: scope.clinic_id,
      groupIdRaw: scope.group_id,
      assignmentScopeRaw: scope.assignment_scope,
      allowLegacyUserFallback: true
    }),
    listScopedMetaAssets(scope),
    listScopedGoogleAccounts(scope)
  ]);

  const tracking = resolveEffectiveTrackingConfig(scope, records);
  const effectiveMeta = pickEffectiveMetaAsset(metaAssets, tracking.meta_ads);
  const effectiveGoogle = pickEffectiveGoogleAccount(googleAccounts, tracking.google_ads);

  return {
    scope,
    descriptors,
    records,
    tracking,
    meta: {
      connection: metaConnectionResolution?.connection || null,
      connection_source: metaConnectionResolution?.source || null,
      available_assets: metaAssets,
      effective_assets: effectiveMeta
    },
    google: {
      connection: googleConnectionResolution?.connection || null,
      connection_source: googleConnectionResolution?.source || null,
      available_accounts: googleAccounts,
      effective_assets: effectiveGoogle
    }
  };
}

module.exports = {
  extractGoogleTagId,
  mergeGoogleAdsConfig,
  normalizeMetaAdAccountId,
  normalizeMetaAdsConfig,
  normalizeGoogleAdsConfig,
  normalizeGoogleAdsDestinations,
  loadScopeIntakeRecords,
  resolveEffectiveTrackingConfig,
  listScopedMetaAssets,
  listScopedGoogleAccounts,
  pickEffectiveMetaAsset,
  pickEffectiveGoogleAccount,
  listMetaPixelsForScopeAdAccount,
  resolveEffectiveMarketingState
};
