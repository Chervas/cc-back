'use strict';

const axios = require('axios');
const db = require('../../models');
const { queues } = require('./queue.service');
const whatsappTemplatesService = require('./whatsappTemplates.service');
const whatsappConnectionStatusService = require('./whatsappConnectionStatus.service');
const whatsappDeliveryGovernanceService = require('./whatsappDeliveryGovernance.service');
const whatsappAccountHealthService = require('./whatsappAccountHealth.service');
const {
  haveSameTemplateComponents,
} = require('../lib/whatsapp-template-components');
const {
  normalizeWabaOperationalSnapshot,
} = require('../lib/whatsapp-account-health');

const { ClinicMetaAsset, Clinica, WhatsappTemplate, WhatsappTemplateCatalog, Sequelize } = db;
const { Op } = Sequelize;

const META_API_VERSION = process.env.META_API_VERSION || 'v24.0';
const TEMPLATE_CREATE_ENSURE_COOLDOWN_MS = Number(
  process.env.WHATSAPP_TEMPLATE_CREATE_ENSURE_COOLDOWN_MS || 60 * 60 * 1000
);
const PHONE_FULL_SYNC_INTERVAL_MS = Math.max(
  15,
  Number(process.env.WHATSAPP_PHONE_FULL_SYNC_INTERVAL_MINUTES || 60) || 60
) * 60 * 1000;
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '1807844546609897';
const REQUIRED_WEBHOOK_FIELDS = Object.freeze([
  'account_review_update',
  'account_update',
  'messages',
]);
let appWebhookConfigurationCache = null;

function getMetaBaseUrl() {
  return `https://graph.facebook.com/${META_API_VERSION}`;
}

function isTestDisplayNumber(displayPhoneNumber) {
  if (!displayPhoneNumber) return false;
  const digitsOnly = String(displayPhoneNumber).replace(/\D/g, '');
  // Meta test numbers often start with 1555...
  return digitsOnly.startsWith('1555');
}

function hasSameTemplateCatalogContract(catalog, instance) {
  if (!catalog || !instance) return false;
  return String(catalog.category || '').trim().toUpperCase() === String(instance.category || '').trim().toUpperCase()
    && haveSameTemplateComponents(catalog.components, instance.components);
}

function normalizeWhatsappBusinessProfile(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload[0] || null;
  if (Array.isArray(payload.data)) return payload.data[0] || null;
  return payload;
}

function buildRegisteredSnapshot(remote, existingRegistration, isCoexistence = false) {
  const nowIso = new Date().toISOString();
  const codeStatus = String(remote?.code_verification_status || '').toUpperCase();
  const isVerified = codeStatus === 'VERIFIED';
  const isConnected = remote?.status === 'CONNECTED';
  let status = existingRegistration?.status || null;
  let requiresPin = existingRegistration?.requiresPin || false;

  if (isConnected && (isVerified || isCoexistence)) {
    status = 'registered';
    requiresPin = false;
  } else if (isConnected && !isVerified) {
    status = 'not_registered';
    requiresPin = true;
  }

  return {
    status,
    requiresPin,
    lastAttemptAt: nowIso,
    registeredAt: existingRegistration?.registeredAt || nowIso,
    phoneStatus: remote?.status || null,
    codeVerificationStatus: remote?.code_verification_status || null,
    lastErrorCode: null,
    lastErrorMessage: null,
    skipRegisterReason: isCoexistence
      ? (existingRegistration?.skipRegisterReason || 'whatsapp_business_app_coexistence')
      : existingRegistration?.skipRegisterReason,
  };
}

async function fetchRemotePhones({ wabaId, accessToken }) {
  const resp = await axios.get(`${getMetaBaseUrl()}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields:
        'id,display_phone_number,verified_name,status,code_verification_status,quality_rating,whatsapp_business_manager_messaging_limit,name_status,new_display_name,new_name_status,platform_type,account_mode,is_on_biz_app',
    },
  });
  return resp.data?.data || [];
}

async function fetchPhoneProfile({ phoneNumberId, accessToken }) {
  if (!phoneNumberId) return null;
  const resp = await axios.get(`${getMetaBaseUrl()}/${phoneNumberId}/whatsapp_business_profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields: 'about,description,profile_picture_url,vertical,email,websites,address',
    },
  });
  return normalizeWhatsappBusinessProfile(resp.data);
}

async function fetchNameStatus({ phoneNumberId, accessToken }) {
  if (!phoneNumberId) return null;
  const resp = await axios.get(`${getMetaBaseUrl()}/${phoneNumberId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields: 'id,verified_name,name_status,new_display_name,new_name_status',
    },
  });
  return resp.data || null;
}

async function fetchWabaOperationalStatus({ wabaId, accessToken }) {
  if (!wabaId || !accessToken) return null;
  const resp = await axios.get(`${getMetaBaseUrl()}/${wabaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields: 'id,name,account_review_status,business_verification_status,health_status',
    },
  });
  return normalizeWabaOperationalSnapshot(resp.data, new Date());
}

function providerErrorSummary(error) {
  const provider = error?.response?.data?.error || {};
  return {
    code: provider.code || error?.code || null,
    type: provider.type || null,
    http_status: error?.response?.status || null,
  };
}

async function fetchAppWebhookConfiguration({ force = false } = {}) {
  const now = Date.now();
  if (!force && appWebhookConfigurationCache?.expires_at > now) {
    return appWebhookConfigurationCache.value;
  }
  const appSecret = process.env.META_APP_SECRET;
  if (!META_APP_ID || !appSecret) {
    return {
      available: false,
      active: null,
      callback_host: null,
      fields: [],
      missing_fields: [...REQUIRED_WEBHOOK_FIELDS],
      error: { code: 'meta_app_credentials_missing', type: null, http_status: null },
    };
  }

  try {
    const response = await axios.get(`${getMetaBaseUrl()}/${META_APP_ID}/subscriptions`, {
      params: { access_token: `${META_APP_ID}|${appSecret}` },
      timeout: 15000,
    });
    const subscription = (response.data?.data || []).find((item) => (
      String(item?.object || '').toLowerCase() === 'whatsapp_business_account'
    )) || null;
    const fields = (subscription?.fields || [])
      .map((field) => String(typeof field === 'string' ? field : field?.name || '').toLowerCase())
      .filter(Boolean)
      .sort();
    const value = {
      available: true,
      active: subscription?.active !== false && Boolean(subscription),
      callback_host: (() => {
        try { return new URL(subscription?.callback_url).host; } catch { return null; }
      })(),
      fields,
      missing_fields: REQUIRED_WEBHOOK_FIELDS.filter((field) => !fields.includes(field)),
      error: null,
    };
    appWebhookConfigurationCache = {
      expires_at: now + PHONE_FULL_SYNC_INTERVAL_MS,
      value,
    };
    return value;
  } catch (error) {
    const value = {
      available: false,
      active: null,
      callback_host: null,
      fields: [],
      missing_fields: [...REQUIRED_WEBHOOK_FIELDS],
      error: providerErrorSummary(error),
    };
    appWebhookConfigurationCache = {
      expires_at: now + Math.min(PHONE_FULL_SYNC_INTERVAL_MS, 5 * 60 * 1000),
      value,
    };
    return value;
  }
}

async function fetchWebhookSubscriptionStatus({ wabaId, accessToken }) {
  const checkedAt = new Date().toISOString();
  let wabaSubscription = null;
  let wabaError = null;
  try {
    const response = await axios.get(`${getMetaBaseUrl()}/${wabaId}/subscribed_apps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    const apps = (response.data?.data || []).map((item) => ({
      id: String(item?.whatsapp_business_api_data?.id || item?.id || ''),
      override_callback_host: (() => {
        try { return new URL(item?.override_callback_uri).host; } catch { return null; }
      })(),
    }));
    wabaSubscription = apps.find((app) => app.id === String(META_APP_ID)) || null;
  } catch (error) {
    wabaError = providerErrorSummary(error);
  }

  const appConfiguration = await fetchAppWebhookConfiguration();
  const missingFields = appConfiguration.missing_fields || [];
  const definitivelyMissing = (!wabaError && !wabaSubscription)
    || (appConfiguration.available && (!appConfiguration.active || missingFields.length > 0));
  const subscribed = Boolean(
    wabaSubscription
    && appConfiguration.available
    && appConfiguration.active
    && missingFields.length === 0
  );

  return {
    status: subscribed ? 'subscribed' : definitivelyMissing ? 'missing' : 'unknown',
    waba_subscribed: wabaError ? null : Boolean(wabaSubscription),
    app_configuration_active: appConfiguration.active,
    expected_app_id: META_APP_ID || null,
    callback_host: wabaSubscription?.override_callback_host || appConfiguration.callback_host || null,
    required_fields: [...REQUIRED_WEBHOOK_FIELDS],
    missing_fields: missingFields,
    checked_at: checkedAt,
    source: 'meta_graph_subscription_audit',
    error: wabaError || appConfiguration.error || null,
  };
}

async function queueWebhookSubscriptionTransition({ localPhones, previousStatuses, snapshot }) {
  const first = localPhones[0] || null;
  if (!first || !snapshot || snapshot.status === 'unknown') return null;
  const hadMissing = previousStatuses.has('missing');
  const becameMissing = snapshot.status === 'missing' && !hadMissing;
  const recovered = snapshot.status === 'subscribed' && hadMissing;
  if (!becameMissing && !recovered) return null;

  const systemNotifications = require('./systemNotifications.service');
  return systemNotifications.queueNotification({
    eventKey: becameMissing
      ? 'whatsapp.webhook_subscription_missing'
      : 'whatsapp.webhook_subscription_recovered',
    payload: becameMissing
      ? {
          severity: 'critical',
          title: `Webhook de WhatsApp sin cobertura para ${first.waVerifiedName || first.metaAssetName || 'una cuenta'}`,
          detail: 'La app o alguno de los campos obligatorios ya no figura suscrito en Meta. El envío sigue bajo control del cortacircuitos, pero podrían no llegar cambios en tiempo real.',
          action: 'Revisar la suscripción en Monitorización > WhatsApp.',
        }
      : {
          severity: 'info',
          title: `Webhook de WhatsApp restablecido para ${first.waVerifiedName || first.metaAssetName || 'una cuenta'}`,
          detail: 'Meta vuelve a confirmar la app y los campos de webhook obligatorios.',
          action: 'Comprobar el historial de la cuenta en Monitorización > WhatsApp.',
        },
    force: true,
    metadata: {
      source: 'whatsapp_webhook_subscription_audit',
      asset_id: Number(first.id),
      waba_id: String(first.wabaId || ''),
      subscription_status: snapshot.status,
      missing_fields: snapshot.missing_fields || [],
    },
  });
}

async function disableDeletedPhone(asset) {
  const additionalData = { ...(asset.additionalData || {}) };
  const registration = additionalData.registration || {};
  additionalData.registration = {
    ...registration,
    status: 'deleted',
    phoneStatus: 'DELETED',
    requiresPin: false,
    lastAttemptAt: new Date().toISOString(),
    lastErrorCode: 33,
    lastErrorMessage: 'phone_deleted_in_meta',
  };
  asset.additionalData = { ...additionalData };
  asset.isActive = false;
  asset.assignmentScope = 'unassigned';
  asset.clinicaId = null;
  asset.grupoClinicaId = null;
  await asset.save();
}

async function upsertRemoteState(
  asset,
  remote,
  profile,
  { fullSync = false, wabaSnapshot = null, webhookSubscription = null } = {}
) {
  const nowIso = new Date().toISOString();
  const additionalData = { ...(asset.additionalData || {}) };
  const registration = additionalData.registration || {};
  const testNumber = isTestDisplayNumber(remote?.display_phone_number);
  const isCoexistence =
    additionalData.whatsappConnectionMode === 'coexistence' ||
    additionalData.connectionMode === 'coexistence' ||
    additionalData.isOnBizApp === true ||
    additionalData.coexistence?.enabled === true ||
    registration?.skipRegisterReason === 'whatsapp_business_app_coexistence';

  additionalData.isTestNumber = testNumber;
  additionalData.limitedMode = testNumber;
  if (remote?.name_status) {
    additionalData.nameStatus = remote.name_status;
  }
  if (remote?.new_display_name !== undefined) {
    additionalData.newDisplayName = remote.new_display_name || null;
  }
  if (remote?.new_name_status !== undefined) {
    additionalData.newNameStatus = remote.new_name_status || null;
  }
  if (remote?.platform_type) {
    additionalData.platformType = remote.platform_type;
  }
  if (remote?.account_mode) {
    additionalData.accountMode = remote.account_mode;
  }
  if (remote?.is_on_biz_app !== undefined && remote?.is_on_biz_app !== null) {
    additionalData.isOnBizApp = remote.is_on_biz_app;
  }
  if (profile) {
    additionalData.profileDescription = profile.description || profile.about || additionalData.profileDescription || null;
    additionalData.profileCategory = profile.vertical || additionalData.profileCategory || null;
    additionalData.profilePictureUrl = profile.profile_picture_url || additionalData.profilePictureUrl || null;
    additionalData.profileEmail = profile.email || additionalData.profileEmail || null;
    additionalData.profileWebsite = profile.websites?.[0] || additionalData.profileWebsite || null;
    additionalData.profileAddress = profile.address || additionalData.profileAddress || null;
  }
  if (wabaSnapshot) {
    additionalData.whatsappBusinessHealth = wabaSnapshot;
    additionalData.businessVerificationStatus = wabaSnapshot.business_verification_status
      || additionalData.businessVerificationStatus
      || null;
    additionalData.businessId = wabaSnapshot.business_id || additionalData.businessId || null;
  }
  if (webhookSubscription) {
    additionalData.whatsappWebhookSubscription = webhookSubscription;
  }

  if (remote?.status === 'CONNECTED') {
    additionalData.registration = buildRegisteredSnapshot(remote, registration, isCoexistence);
  } else {
    additionalData.registration = {
      ...registration,
      phoneStatus: remote?.status || null,
      codeVerificationStatus: remote?.code_verification_status || null,
      lastAttemptAt: nowIso,
      lastErrorCode: registration?.lastErrorCode || null,
      lastErrorMessage: registration?.lastErrorMessage || null,
    };
  }
  additionalData.whatsappPhoneSync = {
    ...(additionalData.whatsappPhoneSync || {}),
    status_checked_at: nowIso,
    ...(fullSync ? { last_full_sync_at: nowIso } : {}),
  };

  asset.additionalData = { ...additionalData };
  asset.metaAssetId = remote?.id || asset.metaAssetId;
  asset.metaAssetName = remote?.display_phone_number || asset.metaAssetName;
  asset.waVerifiedName = remote?.verified_name || asset.waVerifiedName;
  asset.quality_rating = remote?.quality_rating || asset.quality_rating;
  asset.messaging_limit = remote?.whatsapp_business_manager_messaging_limit || asset.messaging_limit;

  // A remote phone can still exist in Meta after the clinic unlinks it.
  // Do not make hidden/unassigned numbers operational again during sync.
  const hasAssignedScope = Boolean(asset.clinicaId || asset.grupoClinicaId);
  if (!hasAssignedScope) {
    asset.isActive = false;
    asset.assignmentScope = 'unassigned';
  } else if (!asset.isActive) {
    asset.isActive = true;
  }

  await asset.save();
}

function isOperationalPhoneAsset(asset, remote) {
  const additionalData = asset?.additionalData || {};
  const registration = additionalData.registration || {};
  const remoteStatus = String(remote?.status || registration.phoneStatus || '').toUpperCase();
  const registrationStatus = String(registration.status || '').toLowerCase();
  const hasScope = Boolean(asset?.clinicaId || asset?.grupoClinicaId);
  return Boolean(
    asset?.isActive
    && asset?.wabaId
    && asset?.waAccessToken
    && hasScope
    && remoteStatus === 'CONNECTED'
    && registrationStatus === 'registered'
  );
}

function resolveTemplateAssignmentScope(asset) {
  const scope = String(asset?.assignmentScope || '').trim().toLowerCase();
  if (scope === 'group' && asset?.grupoClinicaId) return 'group';
  if (scope === 'clinic' && asset?.clinicaId) return 'clinic';
  if (asset?.grupoClinicaId && !asset?.clinicaId) return 'group';
  return 'clinic';
}

function hasRecentTemplateEnsure(additionalData) {
  const lastQueuedAt = additionalData?.templatesCreateEnsure?.lastQueuedAt;
  if (!lastQueuedAt) return false;
  const lastTs = new Date(lastQueuedAt).getTime();
  if (!Number.isFinite(lastTs)) return false;
  const cooldownMs = Number.isFinite(TEMPLATE_CREATE_ENSURE_COOLDOWN_MS) && TEMPLATE_CREATE_ENSURE_COOLDOWN_MS >= 0
    ? TEMPLATE_CREATE_ENSURE_COOLDOWN_MS
    : 60 * 60 * 1000;
  return Date.now() - lastTs < cooldownMs;
}

async function getTemplateCreateNeed(asset) {
  const wabaId = String(asset?.wabaId || '').trim();
  if (!wabaId) return { needed: false, bypassCooldown: false };

  const activeGenericCatalogs = WhatsappTemplateCatalog
    ? await WhatsappTemplateCatalog.findAll({
        where: { is_active: true, is_generic: true },
        attributes: ['id', 'category', 'components'],
        raw: true,
      })
    : [];
  const activeGenericCatalogIds = activeGenericCatalogs.map((row) => Number(row.id)).filter(Boolean);

  const groupId = Number(asset?.grupoClinicaId || 0);
  const isGroupScope =
    String(asset?.assignmentScope || '').trim().toLowerCase() === 'group' &&
    Number.isInteger(groupId) &&
    groupId > 0;

  const connectedCount = await WhatsappTemplate.count({
    where: {
      waba_id: wabaId,
      is_active: true,
      catalog_template_id: { [Op.ne]: null },
      meta_template_id: { [Op.ne]: null },
    },
  });

  if (connectedCount === 0) return { needed: true, bypassCooldown: true };

  if (activeGenericCatalogIds.length) {
    const existingCatalogRows = await WhatsappTemplate.findAll({
      where: {
        waba_id: wabaId,
        is_active: true,
        catalog_template_id: { [Op.in]: activeGenericCatalogIds },
        meta_template_id: { [Op.ne]: null },
      },
      attributes: ['catalog_template_id', 'category', 'components'],
      raw: true,
    });
    const existingByCatalogId = new Map();
    for (const row of existingCatalogRows) {
      const catalogId = Number(row.catalog_template_id);
      if (!catalogId) continue;
      if (!existingByCatalogId.has(catalogId)) existingByCatalogId.set(catalogId, []);
      existingByCatalogId.get(catalogId).push(row);
    }
    const hasMissingOrOutdatedGeneric = activeGenericCatalogs.some((catalog) => {
      const catalogId = Number(catalog.id);
      const rows = existingByCatalogId.get(catalogId) || [];
      return !rows.some((row) => hasSameTemplateCatalogContract(catalog, row));
    });
    if (hasMissingOrOutdatedGeneric) {
      return { needed: true, bypassCooldown: true };
    }
  }

  if (isGroupScope) {
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    const clinicIds = clinics
      .map((clinic) => Number(clinic?.id_clinica || 0))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!clinicIds.length) return { needed: false, bypassCooldown: false };

    const localPendingCount = await WhatsappTemplate.count({
      where: {
        clinic_id: { [Op.in]: clinicIds },
        waba_id: null,
        is_active: true,
        catalog_template_id: { [Op.ne]: null },
        [Op.or]: [
          { status: 'SIN_CONECTAR' },
          {
            [Op.and]: [
              { meta_template_id: { [Op.is]: null } },
              { status: { [Op.notIn]: ['PENDING_LOCAL', 'LOCAL_PENDING', 'REJECTED'] } },
            ],
          },
        ],
      },
    });

    return { needed: localPendingCount > 0, bypassCooldown: false };
  }

  if (!asset?.clinicaId) return { needed: false, bypassCooldown: false };

  const localPendingCount = await WhatsappTemplate.count({
    where: {
      clinic_id: asset.clinicaId,
      waba_id: null,
      is_active: true,
      catalog_template_id: { [Op.ne]: null },
      [Op.or]: [
        { status: 'SIN_CONECTAR' },
        {
          [Op.and]: [
            { meta_template_id: { [Op.is]: null } },
            { status: { [Op.notIn]: ['PENDING_LOCAL', 'LOCAL_PENDING', 'REJECTED'] } },
          ],
        },
      ],
    },
  });

  return { needed: localPendingCount > 0, bypassCooldown: false };
}

async function maybeEnsureTemplatesForOperationalPhone(asset, remote) {
  if (!isOperationalPhoneAsset(asset, remote)) return;

  const additionalData = { ...(asset.additionalData || {}) };
  const templateNeed = await getTemplateCreateNeed(asset);
  if (!templateNeed.needed) return;
  if (!templateNeed.bypassCooldown && hasRecentTemplateEnsure(additionalData)) return;

  const assignmentScope = resolveTemplateAssignmentScope(asset);
  await whatsappTemplatesService.enqueueCreateTemplatesJob({
    wabaId: asset.wabaId,
    clinicId: assignmentScope === 'clinic' ? asset.clinicaId : null,
    groupId: assignmentScope === 'group' ? asset.grupoClinicaId : null,
    assignmentScope,
    source: 'whatsapp_phone_sync_operational',
  });

  additionalData.templatesCreateEnsure = {
    ...(additionalData.templatesCreateEnsure || {}),
    lastQueuedAt: new Date().toISOString(),
    reason: 'operational_phone_sync',
    wabaId: asset.wabaId,
    phoneNumberId: asset.phoneNumberId || null,
    assignmentScope,
  };
  asset.additionalData = additionalData;
  await asset.save();
}

async function resolveAccessToken(wabaId) {
  const asset = await ClinicMetaAsset.findOne({
    where: {
      wabaId,
      assetType: 'whatsapp_phone_number',
      waAccessToken: { [db.Sequelize.Op.ne]: null },
    },
    order: [['updatedAt', 'DESC']],
  });
  return (
    asset?.waAccessToken ||
    process.env.META_WHATSAPP_ACCESS_TOKEN ||
    process.env.META_GRAPH_TOKEN ||
    null
  );
}

async function syncPhonesForWaba({ wabaId, accessToken, ensureTemplates = true, mode = 'auto' }) {
  if (!wabaId) {
    throw new Error('wabaId_required');
  }

  const token = accessToken || (await resolveAccessToken(wabaId));
  if (!token) {
    throw new Error('access_token_missing');
  }

  const remotePhones = await fetchRemotePhones({ wabaId, accessToken: token });
  const remoteMap = new Map(remotePhones.map((p) => [p.id, p]));

  const localPhones = await ClinicMetaAsset.findAll({
    where: {
      wabaId,
      assetType: 'whatsapp_phone_number',
    },
    order: [['updatedAt', 'DESC']],
  });
  const normalizedMode = ['auto', 'full', 'health'].includes(String(mode || '').toLowerCase())
    ? String(mode).toLowerCase()
    : 'auto';
  const mostRecentFullSync = localPhones.reduce((latest, asset) => {
    const value = asset.additionalData?.whatsappPhoneSync?.last_full_sync_at;
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
  const performFullSync = normalizedMode === 'full'
    || (normalizedMode === 'auto' && (!mostRecentFullSync || Date.now() - mostRecentFullSync >= PHONE_FULL_SYNC_INTERVAL_MS));
  let wabaSnapshot = null;
  let webhookSubscription = null;
  const previousWebhookSubscriptionStatuses = new Set(
    localPhones
      .map((asset) => String(asset.additionalData?.whatsappWebhookSubscription?.status || '').toLowerCase())
      .filter(Boolean)
  );
  if (performFullSync) {
    const [wabaResult, subscriptionResult] = await Promise.allSettled([
      fetchWabaOperationalStatus({ wabaId, accessToken: token }),
      fetchWebhookSubscriptionStatus({ wabaId, accessToken: token }),
    ]);
    if (wabaResult.status === 'fulfilled') {
      wabaSnapshot = wabaResult.value;
    } else {
      console.warn('[whatsapp] No se pudo obtener la salud general del WABA', {
        wabaId,
        error: wabaResult.reason?.response?.data?.error?.code
          || wabaResult.reason?.code
          || wabaResult.reason?.message
          || 'waba_status_failed',
      });
    }
    if (subscriptionResult.status === 'fulfilled') {
      webhookSubscription = subscriptionResult.value;
    } else {
      console.warn('[whatsapp] No se pudo auditar la suscripción del webhook', {
        wabaId,
        error: subscriptionResult.reason?.response?.data?.error?.code
          || subscriptionResult.reason?.code
          || subscriptionResult.reason?.message
          || 'webhook_subscription_audit_failed',
      });
    }
  }

  // El estado del número se consulta en cada ciclo. WABA, nombre y perfil se
  // enriquecen como máximo una vez por hora.
  const nameStatusMap = new Map();
  const profileMap = new Map();
  for (const remote of performFullSync ? remotePhones : []) {
    try {
      const statusInfo = await fetchNameStatus({
        phoneNumberId: remote.id,
        accessToken: token,
      });
      if (statusInfo) {
        nameStatusMap.set(remote.id, {
          nameStatus: statusInfo.name_status || null,
          newDisplayName: statusInfo.new_display_name || null,
          newNameStatus: statusInfo.new_name_status || null,
          nameStatusReason: null,
        });
      }
    } catch (err) {
      // No bloquear sync por fallos puntuales
      console.warn('[whatsapp] No se pudo obtener name_status', remote?.id, err?.message || err);
    }
    try {
      const profileInfo = await fetchPhoneProfile({
        phoneNumberId: remote.id,
        accessToken: token,
      });
      if (profileInfo) {
        profileMap.set(remote.id, profileInfo);
      }
    } catch (err) {
      console.warn('[whatsapp] No se pudo obtener perfil', remote?.id, err?.message || err);
    }
  }

  for (const asset of localPhones) {
    const remote = remoteMap.get(asset.phoneNumberId);
    if (!remote) {
      const previousHealth = whatsappAccountHealthService.summarizeAssetHealth(asset);
      await whatsappAccountHealthService.recordObservationForAsset({
        assetId: asset.id,
        signal: { providerStatus: 'DELETED', registrationStatus: 'deleted' },
        source: 'whatsapp_phone_sync',
        previousHealth,
      }).catch(() => null);
      await asset.reload();
      await disableDeletedPhone(asset);
      continue;
    }
    // Inyectar nameStatus más fiable si existe
    const statusExtra = nameStatusMap.get(remote.id);
    if (statusExtra) {
      const additionalData = { ...(asset.additionalData || {}) };
      additionalData.nameStatus = statusExtra.nameStatus;
      additionalData.newDisplayName = statusExtra.newDisplayName;
      additionalData.newNameStatus = statusExtra.newNameStatus;
      additionalData.nameStatusReason = statusExtra.nameStatusReason;
      asset.additionalData = { ...additionalData };
    }
    const profileInfo = profileMap.get(remote.id) || null;
    const previousHealth = whatsappAccountHealthService.summarizeAssetHealth(asset);
    await upsertRemoteState(asset, remote, profileInfo, {
      fullSync: performFullSync,
      wabaSnapshot,
      webhookSubscription,
    });
    const healthResult = await whatsappAccountHealthService.recordObservationForAsset({
      assetId: asset.id,
      signal: {
        providerStatus: remote?.status,
        registrationStatus: asset.additionalData?.registration?.status,
        qualityRating: remote?.quality_rating || asset.quality_rating,
        accountReviewStatus: wabaSnapshot?.account_review_status,
        wabaCanSendMessage: wabaSnapshot?.can_send_message,
        businessVerificationStatus: wabaSnapshot?.business_verification_status,
        webhookSubscriptionStatus: webhookSubscription?.status,
      },
      source: 'whatsapp_phone_sync',
      previousHealth,
    }).catch((error) => {
      console.warn('[whatsapp health] No se pudo materializar el estado del número', {
        wabaId,
        phoneNumberId: asset.phoneNumberId || remote.id,
        error: error?.message || error,
      });
      return null;
    });
    if (healthResult?.health) {
      asset.additionalData = {
        ...(asset.additionalData || {}),
        whatsappHealth: healthResult.health,
      };
    }
    await whatsappDeliveryGovernanceService.recordCapabilitySnapshot({
      clinicId: asset.clinicaId || null,
      wabaId: asset.wabaId || wabaId,
      phoneNumberId: asset.phoneNumberId || remote.id,
      value: remote,
      source: 'whatsapp_phone_sync',
    }).catch((error) => {
      console.warn('[whatsapp delivery] No se pudo conservar el límite del portfolio', {
        wabaId,
        phoneNumberId: asset.phoneNumberId || remote.id,
        error: error?.message || error,
      });
    });
    if (
      String(remote?.status || '').toUpperCase() === 'CONNECTED'
      && healthResult?.health?.can_send !== false
    ) {
      await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
        phoneId: asset.phoneNumberId || remote.id,
        wabaId: asset.wabaId || wabaId,
        source: 'whatsapp_phone_sync_connected',
      });
    }
    if (ensureTemplates && performFullSync && healthResult?.health?.can_send !== false) {
      await maybeEnsureTemplatesForOperationalPhone(asset, remote);
    }
  }

  if (webhookSubscription) {
    await queueWebhookSubscriptionTransition({
      localPhones,
      previousStatuses: previousWebhookSubscriptionStatuses,
      snapshot: webhookSubscription,
    }).catch((error) => {
      console.warn('[whatsapp] No se pudo encolar el aviso de suscripción webhook', {
        wabaId,
        error: error?.code || error?.message || 'webhook_subscription_notification_failed',
      });
    });
  }

  return {
    wabaId,
    remoteCount: remotePhones.length,
    localCount: localPhones.length,
    mode: performFullSync ? 'full' : 'health',
    accountReviewStatus: wabaSnapshot?.account_review_status || null,
    businessVerificationStatus: wabaSnapshot?.business_verification_status || null,
    wabaCanSendMessage: wabaSnapshot?.can_send_message || null,
    webhookSubscriptionStatus: webhookSubscription?.status || null,
  };
}

async function enqueueSyncPhonesJob(data) {
  return queues.whatsappPhoneSync.add('sync', data, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

async function enqueueSyncPhonesForAllWabas({ mode = 'auto' } = {}) {
  const wabas = await ClinicMetaAsset.findAll({
    where: {
      wabaId: { [db.Sequelize.Op.ne]: null },
      assetType: 'whatsapp_phone_number',
      isActive: true,
      waAccessToken: { [db.Sequelize.Op.ne]: null },
      [db.Sequelize.Op.or]: [
        { clinicaId: { [db.Sequelize.Op.ne]: null } },
        { grupoClinicaId: { [db.Sequelize.Op.ne]: null } },
      ],
    },
    attributes: ['wabaId', 'waAccessToken'],
    raw: true,
  });

  const seen = new Set();
  for (const row of wabas) {
    if (!row.wabaId || seen.has(row.wabaId)) continue;
    seen.add(row.wabaId);
    await enqueueSyncPhonesJob({
      wabaId: row.wabaId,
      accessToken: row.waAccessToken,
      mode,
      ensureTemplates: mode !== 'health',
    });
  }

  return { queued: seen.size };
}

module.exports = {
  PHONE_FULL_SYNC_INTERVAL_MS,
  fetchAppWebhookConfiguration,
  fetchWebhookSubscriptionStatus,
  fetchWabaOperationalStatus,
  normalizeWabaOperationalSnapshot,
  syncPhonesForWaba,
  enqueueSyncPhonesJob,
  enqueueSyncPhonesForAllWabas,
};
