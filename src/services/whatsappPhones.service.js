'use strict';

const axios = require('axios');
const db = require('../../models');
const { queues } = require('./queue.service');
const whatsappTemplatesService = require('./whatsappTemplates.service');
const whatsappConnectionStatusService = require('./whatsappConnectionStatus.service');

const { ClinicMetaAsset, WhatsappTemplate, Sequelize } = db;
const { Op } = Sequelize;

const META_API_VERSION = process.env.META_API_VERSION || 'v24.0';
const TEMPLATE_CREATE_ENSURE_COOLDOWN_MS = Number(
  process.env.WHATSAPP_TEMPLATE_CREATE_ENSURE_COOLDOWN_MS || 60 * 60 * 1000
);

function getMetaBaseUrl() {
  return `https://graph.facebook.com/${META_API_VERSION}`;
}

function isTestDisplayNumber(displayPhoneNumber) {
  if (!displayPhoneNumber) return false;
  const digitsOnly = String(displayPhoneNumber).replace(/\D/g, '');
  // Meta test numbers often start with 1555...
  return digitsOnly.startsWith('1555');
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
        'id,display_phone_number,verified_name,status,code_verification_status,quality_rating,messaging_limit_tier,name_status,new_display_name,new_name_status,platform_type,account_mode,is_on_biz_app',
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

async function disableDeletedPhone(asset) {
  const additionalData = { ...(asset.additionalData || {}) };
  const registration = additionalData.registration || {};
  additionalData.registration = {
    ...registration,
    status: 'deleted',
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

async function upsertRemoteState(asset, remote, profile) {
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

  if (remote?.status === 'CONNECTED') {
    additionalData.registration = buildRegisteredSnapshot(remote, registration, isCoexistence);
  } else {
    additionalData.registration = {
      ...registration,
      phoneStatus: remote?.status || null,
      codeVerificationStatus: remote?.code_verification_status || null,
      lastErrorCode: registration?.lastErrorCode || null,
      lastErrorMessage: registration?.lastErrorMessage || null,
    };
  }

  asset.additionalData = { ...additionalData };
  asset.metaAssetId = remote?.id || asset.metaAssetId;
  asset.metaAssetName = remote?.display_phone_number || asset.metaAssetName;
  asset.waVerifiedName = remote?.verified_name || asset.waVerifiedName;
  asset.quality_rating = remote?.quality_rating || asset.quality_rating;
  asset.messaging_limit = remote?.messaging_limit_tier || asset.messaging_limit;

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

async function hasTemplatesNeedingCreate(asset) {
  const wabaId = String(asset?.wabaId || '').trim();
  if (!wabaId) return false;

  const connectedCount = await WhatsappTemplate.count({
    where: {
      waba_id: wabaId,
      is_active: true,
      catalog_template_id: { [Op.ne]: null },
      meta_template_id: { [Op.ne]: null },
    },
  });

  if (connectedCount === 0) return true;

  if (!asset?.clinicaId) return false;

  const localPendingCount = await WhatsappTemplate.count({
    where: {
      clinic_id: asset.clinicaId,
      waba_id: null,
      is_active: true,
      catalog_template_id: { [Op.ne]: null },
      [Op.or]: [
        { status: { [Op.in]: ['SIN_CONECTAR', 'LOCAL_PENDING'] } },
        { meta_template_id: { [Op.is]: null } },
      ],
    },
  });

  return localPendingCount > 0;
}

async function maybeEnsureTemplatesForOperationalPhone(asset, remote) {
  if (!isOperationalPhoneAsset(asset, remote)) return;

  const additionalData = { ...(asset.additionalData || {}) };
  if (hasRecentTemplateEnsure(additionalData)) return;

  const needsCreate = await hasTemplatesNeedingCreate(asset);
  if (!needsCreate) return;

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

async function syncPhonesForWaba({ wabaId, accessToken }) {
  if (!wabaId) {
    throw new Error('wabaId_required');
  }

  const token = accessToken || (await resolveAccessToken(wabaId));
  if (!token) {
    throw new Error('access_token_missing');
  }

  const remotePhones = await fetchRemotePhones({ wabaId, accessToken: token });
  const remoteMap = new Map(remotePhones.map((p) => [p.id, p]));

  // Obtener name_status por phone_number_id (más fiable que el listado)
  const nameStatusMap = new Map();
  const profileMap = new Map();
  for (const remote of remotePhones) {
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

  const localPhones = await ClinicMetaAsset.findAll({
    where: {
      wabaId,
      assetType: 'whatsapp_phone_number',
    },
    order: [['updatedAt', 'DESC']],
  });

  for (const asset of localPhones) {
    const remote = remoteMap.get(asset.phoneNumberId);
    if (!remote) {
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
    await upsertRemoteState(asset, remote, profileInfo);
    if (String(remote?.status || '').toUpperCase() === 'CONNECTED') {
      await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
        phoneId: asset.phoneNumberId || remote.id,
        wabaId: asset.wabaId || wabaId,
        source: 'whatsapp_phone_sync_connected',
      });
    }
    await maybeEnsureTemplatesForOperationalPhone(asset, remote);
  }

  return {
    wabaId,
    remoteCount: remotePhones.length,
    localCount: localPhones.length,
  };
}

async function enqueueSyncPhonesJob(data) {
  return queues.whatsappPhoneSync.add('sync', data, {
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
  });
}

async function enqueueSyncPhonesForAllWabas() {
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
    await enqueueSyncPhonesJob({ wabaId: row.wabaId, accessToken: row.waAccessToken });
  }

  return { queued: seen.size };
}

module.exports = {
  syncPhonesForWaba,
  enqueueSyncPhonesJob,
  enqueueSyncPhonesForAllWabas,
};
