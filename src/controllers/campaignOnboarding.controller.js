'use strict';

const axios = require('axios');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../models');
const {
  googleAdsRequest,
  normalizeCustomerId,
  formatCustomerId,
  ensureGoogleAdsConfig
} = require('../lib/googleAdsClient');

const GoogleConnection = db.GoogleConnection;
const MetaConnection = db.MetaConnection;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const IntakeConfig = db.IntakeConfig;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const ClinicMetaAsset = db.ClinicMetaAsset;
const CampaignRequest = db.CampaignRequest;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

const VALID_MODES = new Set(['connect_only', 'managed_self', 'managed_service']);
const VALID_PROVIDERS = new Set(['google_ads', 'meta_ads']);
const VALID_EVENTS = ['lead', 'contact', 'schedule', 'purchase'];

const EVENT_CATALOG = {
  lead: {
    name: 'Lead - ClinicaClick',
    category: 'LEAD',
    detect: ['lead', 'leads', 'formulario']
  },
  contact: {
    name: 'Contact - ClinicaClick',
    category: 'LEAD',
    detect: ['contact', 'llamada', 'call']
  },
  schedule: {
    name: 'Schedule - ClinicaClick',
    category: 'LEAD',
    detect: ['schedule', 'appointment', 'cita', 'agenda']
  },
  purchase: {
    name: 'Purchase - ClinicaClick',
    category: 'PURCHASE',
    detect: ['purchase', 'venta', 'tratamiento', 'pago']
  }
};

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeCurrency(raw) {
  const code = String(raw || 'EUR').trim().toUpperCase();
  if (!code) return 'EUR';
  return code;
}

function getUserId(req) {
  const parsed = parseInteger(req?.userData?.userId);
  return parsed;
}

function hasScopeText(scopesText, scope) {
  if (!scopesText || !scope) return false;
  return String(scopesText).split(/\s+/).includes(scope);
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
    customer_id: normalizeCustomerId(rawConfig.customer_id || rawConfig.customerId || null) || null,
    conversion_action: rawConfig.conversion_action || rawConfig.conversionAction || null,
    conversion_action_id: rawConfig.conversion_action_id || rawConfig.conversionActionId || null,
    send_to: rawConfig.send_to || rawConfig.sendTo || null,
    currency: normalizeCurrency(rawConfig.currency || 'EUR'),
    events: {}
  };
  const events = rawConfig.events && typeof rawConfig.events === 'object' ? rawConfig.events : {};
  for (const key of VALID_EVENTS) {
    const eventCfg = events[key];
    if (!eventCfg || typeof eventCfg !== 'object') continue;
    normalized.events[key] = {
      enabled: eventCfg.enabled !== false,
      conversion_action_id: eventCfg.conversion_action_id || eventCfg.conversionActionId || null,
      currency: normalizeCurrency(eventCfg.currency || normalized.currency || 'EUR')
    };
  }
  return normalized;
}

function mergeGoogleAdsEvents(baseEvents, patchEvents) {
  const out = {};
  const base = baseEvents && typeof baseEvents === 'object' ? baseEvents : {};
  const patch = patchEvents && typeof patchEvents === 'object' ? patchEvents : {};
  for (const key of VALID_EVENTS) {
    const b = base[key] && typeof base[key] === 'object' ? base[key] : {};
    const p = patch[key] && typeof patch[key] === 'object' ? patch[key] : {};
    if (!Object.keys(b).length && !Object.keys(p).length) continue;
    out[key] = {
      enabled: p.enabled !== undefined ? !!p.enabled : (b.enabled !== false),
      conversion_action_id: p.conversion_action_id || p.conversionActionId || b.conversion_action_id || b.conversionActionId || null,
      currency: normalizeCurrency(p.currency || b.currency || 'EUR')
    };
  }
  return out;
}

async function ensureGoogleAccessToken(conn, { allowExpired = false } = {}) {
  if (!conn) {
    const err = new Error('No existe conexión Google para este usuario');
    err.code = 'NO_CONNECTION';
    throw err;
  }
  if (!conn.accessToken) {
    const err = new Error('No existe access token de Google almacenado');
    err.code = 'NO_TOKEN';
    throw err;
  }

  let accessToken = conn.accessToken;
  let expiresAt = conn.expiresAt ? new Date(conn.expiresAt) : null;
  const now = Date.now();
  const refreshThreshold = now + 60_000;

  const shouldRefresh = conn.refreshToken && (!expiresAt || expiresAt.getTime() <= refreshThreshold);
  if (shouldRefresh) {
    try {
      const refreshResp = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: conn.refreshToken
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const nextToken = refreshResp.data?.access_token;
      const expiresIn = refreshResp.data?.expires_in || 3600;
      if (nextToken) {
        accessToken = nextToken;
        expiresAt = new Date(Date.now() + expiresIn * 1000);
        await conn.update({ accessToken, expiresAt });
      }
    } catch (refreshErr) {
      if (!allowExpired) {
        const err = new Error(refreshErr.response?.data?.error_description || refreshErr.message || 'No se pudo refrescar el token');
        err.code = 'REFRESH_FAILED';
        throw err;
      }
    }
  }

  const isExpired = expiresAt ? expiresAt.getTime() <= now : false;
  if (isExpired && !allowExpired) {
    const err = new Error('El token de Google ha expirado');
    err.code = 'TOKEN_EXPIRED';
    throw err;
  }

  return { accessToken, expiresAt, expired: isExpired };
}

async function ensureGoogleAdsAccess(conn) {
  if (!hasScopeText(conn?.scopes || '', GOOGLE_ADS_SCOPE)) {
    const err = new Error('La conexión Google no tiene permisos de Google Ads');
    err.code = 'INSUFFICIENT_SCOPE';
    throw err;
  }
  ensureGoogleAdsConfig();
  return ensureGoogleAccessToken(conn);
}

async function resolveScopeFromInput({ clinicIdRaw, groupIdRaw, assignmentScopeRaw }) {
  const clinicId = parseInteger(clinicIdRaw);
  let groupId = parseInteger(groupIdRaw);
  const assignmentScope = String(assignmentScopeRaw || '').trim().toLowerCase();

  if (!clinicId && !groupId) {
    const err = new Error('clinic_id o group_id es obligatorio');
    err.httpStatus = 400;
    throw err;
  }

  if (assignmentScope === 'group' && !groupId && clinicId) {
    const clinic = await Clinica.findOne({
      where: { id_clinica: clinicId },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true
    });
    if (!clinic) {
      const err = new Error('Clínica no encontrada');
      err.httpStatus = 404;
      throw err;
    }
    groupId = clinic.grupoClinicaId || null;
  }

  if (groupId) {
    const group = await GrupoClinica.findByPk(groupId, {
      attributes: ['id_grupo', 'nombre_grupo', 'ads_assignment_mode', 'web_assignment_mode', 'web_primary_url'],
      raw: true
    });
    if (!group) {
      const err = new Error('Grupo no encontrado');
      err.httpStatus = 404;
      throw err;
    }
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica', 'nombre_clinica', 'url_web'],
      order: [['nombre_clinica', 'ASC']],
      raw: true
    });
    return {
      assignment_scope: 'group',
      clinic_id: clinicId || null,
      group_id: groupId,
      clinics,
      clinic_ids: clinics.map((c) => c.id_clinica).filter(Boolean),
      group
    };
  }

  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'url_web'],
    raw: true
  });
  if (!clinic) {
    const err = new Error('Clínica no encontrada');
    err.httpStatus = 404;
    throw err;
  }

  return {
    assignment_scope: 'clinic',
    clinic_id: clinic.id_clinica,
    group_id: clinic.grupoClinicaId || null,
    clinics: [clinic],
    clinic_ids: [clinic.id_clinica],
    group: null
  };
}

function buildScopeWhere(scope) {
  if (!scope || typeof scope !== 'object') return {};
  if (scope.assignment_scope === 'group') {
    if (!scope.group_id) return {};
    if (scope.clinic_ids.length > 0) {
      return {
        [Op.or]: [
          { grupoClinicaId: scope.group_id },
          { clinicaId: { [Op.in]: scope.clinic_ids } }
        ]
      };
    }
    return { grupoClinicaId: scope.group_id };
  }

  if (!scope.clinic_id && !scope.group_id) return {};
  if (!scope.clinic_id && scope.group_id) {
    return {
      grupoClinicaId: scope.group_id,
      assignmentScope: 'group'
    };
  }

  const or = [{ clinicaId: scope.clinic_id }];
  if (scope.group_id) {
    or.push({
      grupoClinicaId: scope.group_id,
      assignmentScope: 'group'
    });
  }
  return { [Op.or]: or };
}

async function loadIntakeRecordForScope(scope) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };
  const record = await IntakeConfig.findOne({ where, raw: true });
  return record || null;
}

async function upsertIntakeGoogleAdsForScope(scope, googleAdsPatch) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  const existing = await IntakeConfig.findOne({ where });
  if (!existing) {
    await IntakeConfig.create({
      clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
      group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
      assignment_scope: scope.assignment_scope,
      domains: [],
      config: { google_ads: normalizeGoogleAdsConfig(googleAdsPatch) },
      hmac_key: null
    });
    return;
  }

  const existingConfig = existing.config && typeof existing.config === 'object' ? existing.config : {};
  const currentGoogle = normalizeGoogleAdsConfig(existingConfig.google_ads || {});
  const patchGoogle = normalizeGoogleAdsConfig(googleAdsPatch || {});
  const mergedGoogle = {
    ...currentGoogle,
    ...patchGoogle,
    events: mergeGoogleAdsEvents(currentGoogle.events, patchGoogle.events)
  };
  const nextConfig = {
    ...existingConfig,
    google_ads: mergedGoogle
  };
  await existing.update({ config: nextConfig });
}

function extractSendToFromTagSnippets(tagSnippets) {
  if (!Array.isArray(tagSnippets) || !tagSnippets.length) return null;
  const asText = JSON.stringify(tagSnippets);
  const match = asText.match(/AW-\d+\/[A-Za-z0-9\-_]+/);
  return match ? match[0] : null;
}

function mapConversionActionRow(row) {
  const conversion = row?.conversionAction || {};
  const id = conversion.id ? String(conversion.id) : null;
  const resourceName = conversion.resourceName || null;
  return {
    id,
    resource_name: resourceName,
    name: conversion.name || null,
    category: conversion.category || null,
    type: conversion.type || null,
    status: conversion.status || null,
    include_in_conversions_metric: conversion.includeInConversionsMetric !== false,
    primary_for_goal: conversion.primaryForGoal !== false,
    send_to: extractSendToFromTagSnippets(conversion.tagSnippets || [])
  };
}

function buildSuggestedMapping(actions) {
  const mapping = {
    lead: null,
    contact: null,
    schedule: null,
    purchase: null
  };

  for (const action of actions) {
    const name = String(action.name || '').toLowerCase();
    for (const key of VALID_EVENTS) {
      if (mapping[key]) continue;
      const detectTerms = EVENT_CATALOG[key].detect;
      if (detectTerms.some((term) => name.includes(term))) {
        mapping[key] = action.id;
      }
    }
  }

  if (!mapping.lead && actions.length > 0) {
    mapping.lead = actions[0].id;
  }

  return mapping;
}

function listToUniqueArray(values) {
  const out = [];
  const seen = new Set();
  for (const item of values || []) {
    if (!item) continue;
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function buildGoogleAdsCapabilities(connected, hasAdsScope) {
  const enabled = !!connected && !!hasAdsScope;
  return {
    can_list_conversion_actions: enabled,
    can_create_conversion_actions: enabled,
    can_upload_enhanced_conversions: enabled
  };
}

async function findMappedGoogleAccountsForScope(connectionId, scope) {
  const where = {
    googleConnectionId: connectionId,
    isActive: true,
    ...buildScopeWhere(scope)
  };
  const rows = await ClinicGoogleAdsAccount.findAll({
    where,
    order: [['updated_at', 'DESC']],
    raw: true
  });

  const byCustomer = new Map();
  for (const row of rows) {
    const customerId = normalizeCustomerId(row.customerId || '');
    if (!customerId || byCustomer.has(customerId)) continue;
    byCustomer.set(customerId, {
      customer_id: customerId,
      formatted_customer_id: formatCustomerId(customerId),
      descriptive_name: row.descriptiveName || null,
      currency_code: row.currencyCode || null,
      time_zone: row.timeZone || null,
      is_linked: row.managerLinkStatus === 'ACTIVE',
      manager_link_status: row.managerLinkStatus || null,
      mapped_to_scope: true,
      login_customer_id: normalizeCustomerId(row.loginCustomerId || row.managerCustomerId || '') || null
    });
  }

  return Array.from(byCustomer.values());
}

async function findMappedMetaAssetsForScope(metaConnectionId, scope) {
  const where = {
    metaConnectionId,
    isActive: true,
    ...buildScopeWhere(scope)
  };
  const rows = await ClinicMetaAsset.findAll({
    where,
    order: [['updatedAt', 'DESC']],
    raw: true
  });
  const adAccounts = [];
  const byAsset = new Set();
  for (const row of rows) {
    if (row.assetType !== 'ad_account') continue;
    const key = String(row.metaAssetId || '');
    if (!key || byAsset.has(key)) continue;
    byAsset.add(key);
    adAccounts.push({
      ad_account_id: key.startsWith('act_') ? key : `act_${key}`,
      name: row.metaAssetName || null,
      mapped_to_scope: true
    });
  }
  return {
    ad_accounts: adAccounts,
    pixels: []
  };
}

async function resolveLoginCustomerId(connectionId, customerId, scope) {
  const where = {
    googleConnectionId: connectionId,
    customerId: normalizeCustomerId(customerId),
    isActive: true,
    ...buildScopeWhere(scope)
  };
  const mapped = await ClinicGoogleAdsAccount.findOne({
    where,
    order: [['updated_at', 'DESC']],
    raw: true
  });
  if (mapped?.loginCustomerId) return normalizeCustomerId(mapped.loginCustomerId);
  if (mapped?.managerCustomerId) return normalizeCustomerId(mapped.managerCustomerId);
  try {
    return ensureGoogleAdsConfig().managerId;
  } catch (_e) {
    return null;
  }
}

async function listConversionActionsInternal({ accessToken, customerId, loginCustomerId }) {
  const cleanCustomer = normalizeCustomerId(customerId);
  if (!cleanCustomer) {
    const err = new Error('customer_id requerido');
    err.httpStatus = 400;
    throw err;
  }

  const query = [
    'SELECT',
    '  conversion_action.id,',
    '  conversion_action.resource_name,',
    '  conversion_action.name,',
    '  conversion_action.category,',
    '  conversion_action.type,',
    '  conversion_action.status,',
    '  conversion_action.include_in_conversions_metric,',
    '  conversion_action.primary_for_goal,',
    '  conversion_action.tag_snippets',
    'FROM conversion_action',
    "WHERE conversion_action.type = 'UPLOAD_CLICKS'"
  ].join('\n');

  const data = await googleAdsRequest('POST', `customers/${cleanCustomer}/googleAds:search`, {
    accessToken,
    loginCustomerId: loginCustomerId || undefined,
    data: { query }
  });

  const rows = Array.isArray(data?.results) ? data.results : [];
  const actions = rows
    .map(mapConversionActionRow)
    .filter((item) => !!item.id)
    .sort((a, b) => {
      const aEnabled = a.status === 'ENABLED' ? 1 : 0;
      const bEnabled = b.status === 'ENABLED' ? 1 : 0;
      return bEnabled - aEnabled;
    });

  return {
    actions,
    suggested_mapping: buildSuggestedMapping(actions)
  };
}

async function ensureConversionActionsInternal({ accessToken, customerId, loginCustomerId, currency, events, createMissing }) {
  const requestedEvents = listToUniqueArray(
    (Array.isArray(events) && events.length ? events : VALID_EVENTS).filter((key) => VALID_EVENTS.includes(key))
  );
  const current = await listConversionActionsInternal({ accessToken, customerId, loginCustomerId });
  const existingMapping = current.suggested_mapping || {};
  const created = [];
  const existing = [];

  for (const key of requestedEvents) {
    if (existingMapping[key]) {
      const matched = current.actions.find((a) => a.id === existingMapping[key]);
      existing.push({
        event: key,
        id: existingMapping[key],
        name: matched?.name || EVENT_CATALOG[key].name
      });
    }
  }

  if (createMissing) {
    const operations = [];
    const toCreateEvents = [];
    for (const key of requestedEvents) {
      if (existingMapping[key]) continue;
      toCreateEvents.push(key);
      operations.push({
        create: {
          name: EVENT_CATALOG[key].name,
          category: EVENT_CATALOG[key].category,
          type: 'UPLOAD_CLICKS',
          status: 'ENABLED',
          includeInConversionsMetric: true,
          valueSettings: {
            defaultValue: 0,
            alwaysUseDefaultValue: false,
            defaultCurrencyCode: normalizeCurrency(currency)
          },
          countingType: 'ONE_PER_CLICK',
          attributionModelSettings: {
            attributionModel: 'LAST_CLICK'
          }
        }
      });
    }

    if (operations.length > 0) {
      const mutate = await googleAdsRequest('POST', `customers/${normalizeCustomerId(customerId)}/conversionActions:mutate`, {
        accessToken,
        loginCustomerId: loginCustomerId || undefined,
        data: { operations }
      });
      const results = Array.isArray(mutate?.results) ? mutate.results : [];
      for (let i = 0; i < toCreateEvents.length; i += 1) {
        const event = toCreateEvents[i];
        const resourceName = results[i]?.resourceName || null;
        const id = resourceName ? String(resourceName).split('/').pop() : null;
        if (!id) continue;
        existingMapping[event] = id;
        created.push({
          event,
          id,
          name: EVENT_CATALOG[event].name
        });
      }
    }
  }

  const recommended = {
    enabled: true,
    customer_id: normalizeCustomerId(customerId),
    conversion_action_id: existingMapping.lead || null,
    conversion_action: existingMapping.lead
      ? `customers/${normalizeCustomerId(customerId)}/conversionActions/${existingMapping.lead}`
      : null,
    send_to: null,
    currency: normalizeCurrency(currency),
    events: {
      lead: {
        enabled: true,
        conversion_action_id: existingMapping.lead || null,
        currency: normalizeCurrency(currency)
      },
      contact: {
        enabled: true,
        conversion_action_id: existingMapping.contact || null,
        currency: normalizeCurrency(currency)
      },
      schedule: {
        enabled: true,
        conversion_action_id: existingMapping.schedule || null,
        currency: normalizeCurrency(currency)
      },
      purchase: {
        enabled: false,
        conversion_action_id: existingMapping.purchase || null,
        currency: normalizeCurrency(currency)
      }
    }
  };

  return {
    created,
    existing,
    mapping: {
      lead: existingMapping.lead || null,
      contact: existingMapping.contact || null,
      schedule: existingMapping.schedule || null,
      purchase: existingMapping.purchase || null
    },
    recommended_google_ads_config: recommended
  };
}

function initSteps(providers) {
  const steps = [];
  if (providers.includes('google_ads')) {
    steps.push(
      { key: 'google_connect', status: 'pending' },
      { key: 'google_map_account', status: 'pending' },
      { key: 'conversion_actions', status: 'pending' },
      { key: 'persist_intake_config', status: 'pending' }
    );
  }
  if (providers.includes('meta_ads')) {
    steps.push(
      { key: 'meta_connect', status: 'pending' },
      { key: 'meta_map_assets', status: 'pending' }
    );
  }
  return steps;
}

function markStep(steps, key, status, extra) {
  const idx = steps.findIndex((s) => s.key === key);
  if (idx < 0) return;
  steps[idx] = {
    ...steps[idx],
    status,
    ...(extra || {})
  };
}

exports.getCampaignOnboardingBootstrap = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.query.clinic_id,
    groupIdRaw: req.query.group_id,
    assignmentScopeRaw: req.query.assignment_scope
  });

  const intakeRecord = await loadIntakeRecordForScope(scope);
  const intakeConfig = intakeRecord?.config && typeof intakeRecord.config === 'object' ? intakeRecord.config : {};
  const intakeGoogleAds = normalizeGoogleAdsConfig(intakeConfig.google_ads || {});

  let googleConnected = false;
  let googleReason = null;
  let hasAdsScope = false;
  let googleAccounts = [];
  let selectedCustomerId = intakeGoogleAds.customer_id || null;

  const googleConnection = await GoogleConnection.findOne({ where: { userId } });
  if (!googleConnection) {
    googleReason = 'no_connection';
  } else {
    hasAdsScope = hasScopeText(googleConnection.scopes || '', GOOGLE_ADS_SCOPE);
    if (!hasAdsScope) {
      googleReason = 'insufficient_scope';
    } else {
      try {
        await ensureGoogleAdsAccess(googleConnection);
        googleConnected = true;
      } catch (err) {
        googleReason = err.code === 'TOKEN_EXPIRED' || err.code === 'REFRESH_FAILED'
          ? 'token_expired'
          : err.code === 'ADS_CONFIG_MISSING'
            ? 'config_missing'
            : 'token_error';
      }
    }
  }

  if (googleConnection) {
    googleAccounts = await findMappedGoogleAccountsForScope(googleConnection.id, scope);
  }
  if (!selectedCustomerId && googleAccounts.length > 0) {
    selectedCustomerId = googleAccounts[0].customer_id;
  }

  let metaConnected = false;
  let metaReason = null;
  let metaAssets = { ad_accounts: [], pixels: [] };
  const metaConnection = await MetaConnection.findOne({ where: { userId } });
  if (!metaConnection) {
    metaReason = 'no_connection';
  } else {
    metaConnected = true;
    metaAssets = await findMappedMetaAssetsForScope(metaConnection.id, scope);
  }

  const capiMissing = [];
  if (!metaAssets.ad_accounts.length) capiMissing.push('ad_account_mapping');
  if (!(intakeRecord?.hmac_key || '').trim()) capiMissing.push('intake_hmac_key');

  return res.json({
    success: true,
    scope: {
      assignment_scope: scope.assignment_scope,
      clinic_id: scope.clinic_id || null,
      group_id: scope.group_id || null
    },
    modes: ['connect_only', 'managed_self', 'managed_service'],
    google_ads: {
      connected: googleConnected,
      reason: googleReason,
      manager_id: (() => {
        try {
          return formatCustomerId(ensureGoogleAdsConfig().managerId);
        } catch (_e) {
          return null;
        }
      })(),
      accounts: googleAccounts,
      selected_customer_id: selectedCustomerId,
      intake_google_ads: intakeGoogleAds,
      capabilities: buildGoogleAdsCapabilities(googleConnected, hasAdsScope)
    },
    meta_ads: {
      connected: metaConnected,
      reason: metaReason,
      ad_accounts: metaAssets.ad_accounts,
      pixels: metaAssets.pixels,
      capi_readiness: {
        ready: capiMissing.length === 0,
        missing: capiMissing
      }
    }
  });
});

exports.listGoogleAdsConversionActions = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const customerId = normalizeCustomerId(req.query.customer_id || '');
  if (!customerId) return res.status(400).json({ success: false, error: 'customer_id_required' });

  const scope = (req.query.clinic_id || req.query.group_id)
    ? await resolveScopeFromInput({
      clinicIdRaw: req.query.clinic_id,
      groupIdRaw: req.query.group_id,
      assignmentScopeRaw: req.query.assignment_scope
    })
    : {
      assignment_scope: 'clinic',
      clinic_id: null,
      group_id: null,
      clinics: [],
      clinic_ids: [],
      group: null
    };

  const connection = await GoogleConnection.findOne({ where: { userId } });
  if (!connection) return res.status(404).json({ success: false, error: 'no_connection' });
  if (!hasScopeText(connection.scopes || '', GOOGLE_ADS_SCOPE)) {
    return res.status(403).json({ success: false, error: 'insufficient_scope' });
  }

  const { accessToken } = await ensureGoogleAdsAccess(connection);
  const loginCustomerId = normalizeCustomerId(req.query.login_customer_id || '')
    || await resolveLoginCustomerId(connection.id, customerId, scope);

  const result = await listConversionActionsInternal({ accessToken, customerId, loginCustomerId });
  return res.json({
    success: true,
    customer_id: customerId,
    actions: result.actions,
    suggested_mapping: result.suggested_mapping
  });
});

exports.ensureGoogleAdsConversionActions = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const customerId = normalizeCustomerId(req.body?.customer_id || '');
  if (!customerId) return res.status(400).json({ success: false, error: 'invalid_customer_id' });

  const currency = normalizeCurrency(req.body?.currency || 'EUR');
  const createMissing = req.body?.create_missing !== false;
  const events = Array.isArray(req.body?.events) && req.body.events.length
    ? req.body.events.map((e) => String(e || '').trim().toLowerCase())
    : VALID_EVENTS;

  const scope = (req.body?.clinic_id || req.body?.group_id)
    ? await resolveScopeFromInput({
      clinicIdRaw: req.body?.clinic_id,
      groupIdRaw: req.body?.group_id,
      assignmentScopeRaw: req.body?.assignment_scope
    })
    : {
      assignment_scope: 'clinic',
      clinic_id: null,
      group_id: null,
      clinics: [],
      clinic_ids: [],
      group: null
    };

  const connection = await GoogleConnection.findOne({ where: { userId } });
  if (!connection) return res.status(404).json({ success: false, error: 'no_connection' });
  if (!hasScopeText(connection.scopes || '', GOOGLE_ADS_SCOPE)) {
    return res.status(403).json({ success: false, error: 'insufficient_scope' });
  }

  const { accessToken } = await ensureGoogleAdsAccess(connection);
  const loginCustomerId = normalizeCustomerId(req.body?.login_customer_id || '')
    || await resolveLoginCustomerId(connection.id, customerId, scope);

  const ensured = await ensureConversionActionsInternal({
    accessToken,
    customerId,
    loginCustomerId,
    currency,
    events,
    createMissing
  });

  return res.json({
    success: true,
    customer_id: customerId,
    created: ensured.created,
    existing: ensured.existing,
    mapping: ensured.mapping,
    recommended_google_ads_config: ensured.recommended_google_ads_config
  });
});

exports.startCampaignOnboarding = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const mode = String(req.body?.mode || '').trim().toLowerCase();
  if (!VALID_MODES.has(mode)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'mode inválido' });
  }

  const providers = listToUniqueArray(
    (Array.isArray(req.body?.providers) ? req.body.providers : ['google_ads'])
      .map((p) => String(p || '').trim().toLowerCase())
      .filter((p) => VALID_PROVIDERS.has(p))
  );

  if (!providers.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'providers requerido' });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.body?.clinic_id,
    groupIdRaw: req.body?.group_id,
    assignmentScopeRaw: req.body?.assignment_scope
  });

  const anchorClinicId = scope.clinic_id || scope.clinic_ids[0] || null;
  const running = await CampaignRequest.findAll({
    where: {
      clinica_id: anchorClinicId,
      estado: 'en_creacion'
    },
    order: [['created_at', 'DESC']],
    limit: 5
  });
  const hasRunning = running.some((row) => {
    const reqPayload = row?.solicitud || {};
    return reqPayload.kind === 'campaign_onboarding' && reqPayload.status === 'in_progress';
  });
  if (hasRunning) {
    return res.status(409).json({ success: false, error: 'onboarding_already_running' });
  }

  const steps = initSteps(providers);
  const initialPayload = {
    kind: 'campaign_onboarding',
    status: 'in_progress',
    current_step: steps[0]?.key || null,
    mode,
    providers,
    scope: {
      assignment_scope: scope.assignment_scope,
      clinic_id: scope.clinic_id || null,
      group_id: scope.group_id || null
    },
    request: {
      google_ads: req.body?.google_ads || null,
      meta_ads: req.body?.meta_ads || null,
      billing: req.body?.billing || null
    },
    steps,
    result: {}
  };

  const request = await CampaignRequest.create({
    clinica_id: anchorClinicId,
    campaign_id: null,
    estado: 'en_creacion',
    solicitud: initialPayload
  });

  try {
    const result = {};

    if (providers.includes('google_ads')) {
      const googleConnection = await GoogleConnection.findOne({ where: { userId } });
      if (!googleConnection) throw new Error('No hay conexión Google');
      if (!hasScopeText(googleConnection.scopes || '', GOOGLE_ADS_SCOPE)) {
        const scopeErr = new Error('La conexión Google no tiene scope de Ads');
        scopeErr.code = 'INSUFFICIENT_SCOPE';
        throw scopeErr;
      }

      const { accessToken } = await ensureGoogleAdsAccess(googleConnection);
      markStep(steps, 'google_connect', 'done');

      const scopeAccounts = await findMappedGoogleAccountsForScope(googleConnection.id, scope);
      const requestedCustomer = normalizeCustomerId(req.body?.google_ads?.customer_id || '');
      const selectedCustomer = requestedCustomer || scopeAccounts[0]?.customer_id || null;
      if (!selectedCustomer) {
        throw new Error('No hay customer_id de Google Ads mapeado para este scope');
      }

      markStep(steps, 'google_map_account', 'done', { customer_id: selectedCustomer });
      const loginCustomerId = await resolveLoginCustomerId(googleConnection.id, selectedCustomer, scope);

      const autoCreate = req.body?.google_ads?.auto_create_missing_conversions === true;
      const ensurePayload = await ensureConversionActionsInternal({
        accessToken,
        customerId: selectedCustomer,
        loginCustomerId,
        currency: req.body?.google_ads?.currency || 'EUR',
        events: VALID_EVENTS,
        createMissing: autoCreate
      });

      markStep(steps, 'conversion_actions', 'done');

      const mergedGoogleAds = {
        ...ensurePayload.recommended_google_ads_config,
        enabled: true,
        customer_id: selectedCustomer,
        send_to: req.body?.google_ads?.send_to || null
      };
      await upsertIntakeGoogleAdsForScope(scope, mergedGoogleAds);
      markStep(steps, 'persist_intake_config', 'done');

      result.google_ads = {
        customer_id: selectedCustomer,
        mapping: ensurePayload.mapping,
        created_actions: ensurePayload.created
      };
    }

    if (providers.includes('meta_ads')) {
      const metaConnection = await MetaConnection.findOne({ where: { userId } });
      if (!metaConnection) throw new Error('No hay conexión Meta');
      markStep(steps, 'meta_connect', 'done');

      const assets = await findMappedMetaAssetsForScope(metaConnection.id, scope);
      markStep(steps, 'meta_map_assets', 'done');
      result.meta_ads = {
        ad_account_id: req.body?.meta_ads?.ad_account_id || assets.ad_accounts[0]?.ad_account_id || null,
        pixel_id: req.body?.meta_ads?.pixel_id || null
      };
    }

    const finalPayload = {
      ...initialPayload,
      status: 'completed',
      current_step: null,
      steps,
      result
    };
    await request.update({
      estado: 'aprobada',
      solicitud: finalPayload
    });

    return res.status(201).json({
      success: true,
      onboarding_id: request.id,
      status: 'completed',
      current_step: null,
      next_action: 'none'
    });
  } catch (err) {
    const failedPayload = {
      ...(request.solicitud || initialPayload),
      status: 'failed',
      current_step: null,
      steps,
      error: err.message || 'internal_error'
    };
    await request.update({
      estado: 'solicitar_cambio',
      solicitud: failedPayload
    });

    const status = err.code === 'INSUFFICIENT_SCOPE' ? 403 : 500;
    return res.status(status).json({
      success: false,
      error: status === 403 ? 'insufficient_scope' : 'internal_error',
      message: err.message || 'Error iniciando onboarding',
      onboarding_id: request.id
    });
  }
});

exports.getCampaignOnboardingStatus = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const onboardingId = parseInteger(req.params.onboardingId);
  if (!onboardingId) return res.status(400).json({ success: false, error: 'invalid_onboarding_id' });

  const record = await CampaignRequest.findByPk(onboardingId);
  if (!record) return res.status(404).json({ success: false, error: 'not_found' });

  const payload = record.solicitud && typeof record.solicitud === 'object' ? record.solicitud : {};
  if (payload.kind !== 'campaign_onboarding') {
    return res.status(404).json({ success: false, error: 'not_found' });
  }

  return res.json({
    success: true,
    onboarding_id: record.id,
    status: payload.status || 'in_progress',
    mode: payload.mode || null,
    steps: Array.isArray(payload.steps) ? payload.steps : [],
    result: payload.result || {}
  });
});
