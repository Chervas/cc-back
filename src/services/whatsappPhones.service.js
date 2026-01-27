'use strict';

const axios = require('axios');
const db = require('../../models');
const { queues } = require('./queue.service');

const { ClinicMetaAsset } = db;

const META_API_VERSION = process.env.META_API_VERSION || 'v22.0';

function getMetaBaseUrl() {
  return `https://graph.facebook.com/${META_API_VERSION}`;
}

function isTestDisplayNumber(displayPhoneNumber) {
  if (!displayPhoneNumber) return false;
  const digitsOnly = String(displayPhoneNumber).replace(/\D/g, '');
  // Meta test numbers often start with 1555...
  return digitsOnly.startsWith('1555');
}

function buildRegisteredSnapshot(remote, existingRegistration) {
  const nowIso = new Date().toISOString();
  return {
    status: remote?.status === 'CONNECTED' ? 'registered' : existingRegistration?.status || null,
    requiresPin: false,
    lastAttemptAt: nowIso,
    registeredAt: existingRegistration?.registeredAt || nowIso,
    phoneStatus: remote?.status || null,
    codeVerificationStatus: remote?.code_verification_status || null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

async function fetchRemotePhones({ wabaId, accessToken }) {
  const resp = await axios.get(`${getMetaBaseUrl()}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields:
        'id,display_phone_number,verified_name,status,code_verification_status,quality_rating,messaging_limit_tier,name_status',
    },
  });
  return resp.data?.data || [];
}

async function fetchNameStatus({ phoneNumberId, accessToken }) {
  if (!phoneNumberId) return null;
  const resp = await axios.get(`${getMetaBaseUrl()}/${phoneNumberId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields: 'id,name_status',
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

async function upsertRemoteState(asset, remote) {
  const additionalData = { ...(asset.additionalData || {}) };
  const registration = additionalData.registration || {};
  const testNumber = isTestDisplayNumber(remote?.display_phone_number);

  additionalData.isTestNumber = testNumber;
  additionalData.limitedMode = testNumber;
  if (remote?.name_status) {
    additionalData.nameStatus = remote.name_status;
  }

  if (remote?.status === 'CONNECTED') {
    additionalData.registration = buildRegisteredSnapshot(remote, registration);
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

  // If the remote phone still exists, keep it active
  if (!asset.isActive) {
    asset.isActive = true;
  }

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
  return asset?.waAccessToken || null;
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
  for (const remote of remotePhones) {
    try {
      const statusInfo = await fetchNameStatus({
        phoneNumberId: remote.id,
        accessToken: token,
      });
      if (statusInfo) {
        nameStatusMap.set(remote.id, {
          nameStatus: statusInfo.name_status || null,
          nameStatusReason: null,
        });
      }
    } catch (err) {
      // No bloquear sync por fallos puntuales
      console.warn('[whatsapp] No se pudo obtener name_status', remote?.id, err?.message || err);
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
      additionalData.nameStatusReason = statusExtra.nameStatusReason;
      asset.additionalData = { ...additionalData };
    }
    await upsertRemoteState(asset, remote);
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
      waAccessToken: { [db.Sequelize.Op.ne]: null },
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
