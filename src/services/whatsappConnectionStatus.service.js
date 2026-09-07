'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const notificationService = require('./notifications.service');
const { emitNotificationUpdated } = require('./notificationsRealtime.service');

const { ClinicMetaAsset, Clinica, Notification } = db;

const GRAPH_OBJECT_ACCESS_ERROR_CODE = 100;
const GRAPH_OBJECT_ACCESS_ERROR_SUBCODE = 33;
const COEXISTENCE_ERROR_FIELDS = [
  'last_error_code',
  'last_error_subcode',
  'last_error_message',
  'last_error_at',
  'last_message_id',
  'last_recipient',
  'last_source',
];

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeProviderError(error) {
  const raw = error?.response?.data?.error
    || error?.response?.data
    || error?.raw
    || error?.error
    || error
    || {};
  const graphError = raw?.error?.error || raw?.error || raw;
  const code = Number(graphError?.code ?? raw?.code ?? 0) || null;
  const subcode = Number(graphError?.error_subcode ?? graphError?.subcode ?? raw?.error_subcode ?? raw?.subcode ?? 0) || null;
  const message = cleanString(graphError?.message)
    || cleanString(raw?.message)
    || cleanString(error?.message)
    || 'whatsapp_send_failed';

  return {
    raw,
    code,
    subcode,
    type: cleanString(graphError?.type || raw?.type),
    message,
  };
}

function isGraphObjectAccessError(error) {
  const normalized = normalizeProviderError(error);
  if (normalized.code === GRAPH_OBJECT_ACCESS_ERROR_CODE && normalized.subcode === GRAPH_OBJECT_ACCESS_ERROR_SUBCODE) {
    return true;
  }
  const lower = normalized.message.toLowerCase();
  return normalized.code === GRAPH_OBJECT_ACCESS_ERROR_CODE
    && (lower.includes('does not exist') || lower.includes('missing permissions') || lower.includes('cannot be loaded'));
}

function buildReconnectLink({ phoneNumberId = null, wabaId = null } = {}) {
  const params = new URLSearchParams();
  params.set('tab', 'whatsapp');
  params.set('action', 'reconnect_whatsapp');
  if (phoneNumberId) {
    params.set('phoneNumberId', String(phoneNumberId));
  }
  if (wabaId) {
    params.set('wabaId', String(wabaId));
  }
  return `/ajustes?${params.toString()}`;
}

function isDisconnectedCoexistence(coexistence = {}) {
  return coexistence.status === 'disconnected'
    || coexistence.coexistence_status === 'disconnected'
    || coexistence.canSendApi === false
    || coexistence.can_send_api === false
    || coexistence.requiresReconnect === true;
}

async function applyCoexistencePatch(asset, patch = {}, { clearErrorFields = false } = {}) {
  const additionalData = asset?.additionalData && typeof asset.additionalData === 'object'
    ? { ...asset.additionalData }
    : {};
  const previous = additionalData.coexistence && typeof additionalData.coexistence === 'object'
    ? { ...additionalData.coexistence }
    : {};
  const coexistence = {
    ...previous,
    ...patch,
    updated_at: patch.updated_at || new Date().toISOString(),
  };
  if (clearErrorFields) {
    COEXISTENCE_ERROR_FIELDS.forEach((field) => delete coexistence[field]);
  }
  asset.additionalData = { ...additionalData, coexistence };
  asset.changed?.('additionalData', true);
  await asset.save();
  return { was_disconnected: isDisconnectedCoexistence(previous) };
}

async function mirrorWabaCoexistenceStatus({
  wabaId = null,
  patch = {},
  clearErrorFields = false,
} = {}) {
  const normalizedWabaId = cleanString(wabaId);
  if (!ClinicMetaAsset || !normalizedWabaId) {
    return { updated: 0, was_disconnected: false };
  }
  try {
    const assets = await ClinicMetaAsset.findAll({
      where: {
        assetType: 'whatsapp_business_account',
        isActive: true,
        [Op.or]: [
          { wabaId: normalizedWabaId },
          { metaAssetId: normalizedWabaId },
        ],
      },
    });
    let wasDisconnected = false;
    for (const asset of assets) {
      const result = await applyCoexistencePatch(asset, patch, { clearErrorFields });
      wasDisconnected = wasDisconnected || result.was_disconnected;
    }
    return { updated: assets.length, was_disconnected: wasDisconnected };
  } catch (error) {
    console.warn('[whatsapp] No se pudo sincronizar el estado de la WABA relacionada', {
      wabaId: normalizedWabaId,
      error: error?.message || error,
    });
    return { updated: 0, was_disconnected: false, error: error?.message || String(error) };
  }
}

async function markCoexistenceNotificationsRead({ phoneNumberId = null, wabaId = null } = {}) {
  if (!Notification || (!phoneNumberId && !wabaId)) {
    return { count: 0 };
  }

  const notifications = await Notification.findAll({
    where: {
      event: 'whatsapp.coexistence_disconnected',
      isRead: false,
    },
    order: [['createdAt', 'DESC']],
    limit: 250,
  });

  const phoneKey = cleanString(phoneNumberId);
  const wabaKey = cleanString(wabaId);
  const matched = notifications.filter((notification) => {
    const data = notification.data && typeof notification.data === 'object'
      ? notification.data
      : {};
    const link = cleanString(data.link);
    return (phoneKey && (
      String(data.phoneNumberId || '') === phoneKey
      || link.includes(`phoneNumberId=${phoneKey}`)
      || link.includes(`phone_number_id=${phoneKey}`)
    ))
      || (wabaKey && (
        String(data.wabaId || '') === wabaKey
        || link.includes(`wabaId=${wabaKey}`)
        || link.includes(`waba_id=${wabaKey}`)
      ));
  });

  await Promise.all(matched.map(async (notification) => {
    await notification.update({
      isRead: true,
      readAt: new Date(),
    });
    emitNotificationUpdated(notification);
  }));

  return { count: matched.length };
}

async function findWhatsappPhoneAsset({ clinicId = null, phoneId = null, wabaId = null } = {}) {
  if (!ClinicMetaAsset) return null;
  const baseWhere = {
    assetType: 'whatsapp_phone_number',
    isActive: true,
  };

  if (phoneId) {
    const asset = await ClinicMetaAsset.findOne({ where: { ...baseWhere, phoneNumberId: phoneId } });
    if (asset) return asset;
  }
  if (wabaId) {
    const asset = await ClinicMetaAsset.findOne({ where: { ...baseWhere, wabaId } });
    if (asset) return asset;
  }
  if (clinicId) {
    const or = [{ clinicaId: clinicId }];
    if (phoneId) or.push({ phoneNumberId: phoneId });
    if (wabaId) or.push({ wabaId });
    const asset = await ClinicMetaAsset.findOne({
      where: { ...baseWhere, [Op.or]: or },
      order: [['updatedAt', 'DESC']],
    });
    if (asset) return asset;
  }
  return null;
}

async function markDisconnectedAfterProviderError({
  error,
  clinicId = null,
  phoneId = null,
  wabaId = null,
  messageId = null,
  recipient = null,
  source = null,
} = {}) {
  if (!isGraphObjectAccessError(error)) {
    return { marked: false, reason: 'not_graph_object_access_error' };
  }

  const normalized = normalizeProviderError(error);
  const resolvedClinicId = Number(clinicId || 0) || null;
  const asset = await findWhatsappPhoneAsset({ clinicId: resolvedClinicId, phoneId, wabaId });
  const now = new Date().toISOString();
  let wasDisconnected = false;
  const disconnectProjection = {
    status: 'disconnected',
    coexistence_status: 'disconnected',
    canSendApi: false,
    can_send_api: false,
    requiresReconnect: true,
    disconnectReason: 'meta_object_access_lost',
    last_error_code: normalized.code,
    last_error_subcode: normalized.subcode,
    last_error_message: normalized.message,
    last_error_at: now,
    last_message_id: messageId || null,
    last_recipient: cleanString(recipient) || null,
    last_source: cleanString(source) || null,
  };

  if (asset) {
    const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
      ? { ...asset.additionalData }
      : {};
    const coexistence = additionalData.coexistence && typeof additionalData.coexistence === 'object'
      ? { ...additionalData.coexistence }
      : {};
    wasDisconnected = isDisconnectedCoexistence(coexistence);
    const registration = additionalData.registration && typeof additionalData.registration === 'object'
      ? { ...additionalData.registration }
      : {};

    asset.additionalData = {
      ...additionalData,
      coexistence: {
        ...coexistence,
        ...disconnectProjection,
      },
      registration: {
        ...registration,
        lastAttemptAt: now,
        lastErrorCode: normalized.code,
        lastErrorSubcode: normalized.subcode,
        lastErrorMessage: normalized.message,
      },
    };
    await asset.save();
  }

  const resolvedWabaId = wabaId || asset?.wabaId || null;
  const mirrored = await mirrorWabaCoexistenceStatus({
    wabaId: resolvedWabaId,
    patch: disconnectProjection,
  });
  wasDisconnected = wasDisconnected || mirrored.was_disconnected;

  if (!wasDisconnected) {
    try {
      const clinic = resolvedClinicId && Clinica
        ? await Clinica.findByPk(resolvedClinicId, {
            attributes: ['id_clinica', 'nombre_clinica'],
            raw: true,
          })
        : null;

      const phoneNumberId = phoneId || asset?.phoneNumberId || null;
      await notificationService.dispatchEvent({
        event: 'whatsapp.coexistence_disconnected',
        clinicId: resolvedClinicId,
        data: {
          clinicId: resolvedClinicId,
          clinicName: cleanString(clinic?.nombre_clinica),
          phoneNumberId,
          wabaId: resolvedWabaId,
          phoneNumber: cleanString(asset?.displayPhoneNumber || asset?.display_phone_number),
          messageId: messageId || null,
          recipient: cleanString(recipient) || null,
          errorCode: normalized.code,
          errorSubcode: normalized.subcode,
          errorMessage: normalized.message,
          source: cleanString(source) || null,
          link: buildReconnectLink({ phoneNumberId, wabaId: resolvedWabaId }),
          useRouter: true,
          actionLabel: 'Reconectar WhatsApp',
          actionIcon: 'heroicons_outline:arrow-path',
        },
      });
    } catch (notificationError) {
      console.warn('[whatsapp] No se pudo crear notificación de desconexión coexistence', {
        clinicId: resolvedClinicId,
        phoneId,
        wabaId,
        messageId,
        error: notificationError?.message || notificationError,
      });
    }
  }

  return {
    marked: true,
    asset_id: asset?.id || null,
    error_code: normalized.code,
    error_subcode: normalized.subcode,
  };
}

async function clearDisconnectedAfterSuccess({
  clinicId = null,
  phoneId = null,
  wabaId = null,
  messageId = null,
  source = null,
} = {}) {
  const asset = await findWhatsappPhoneAsset({ clinicId: Number(clinicId || 0) || null, phoneId, wabaId });
  if (!asset) return { cleared: false, reason: 'asset_not_found' };
  const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
    ? { ...asset.additionalData }
    : {};
  const coexistence = additionalData.coexistence && typeof additionalData.coexistence === 'object'
    ? { ...additionalData.coexistence }
    : {};
  if (!isDisconnectedCoexistence(coexistence)) {
    return { cleared: false, reason: 'no_disconnect_marker' };
  }

  const successProjection = {
    status: 'active',
    coexistence_status: 'active',
    canSendApi: true,
    can_send_api: true,
    requiresReconnect: false,
    last_success_at: new Date().toISOString(),
    last_success_message_id: messageId || null,
    last_success_source: cleanString(source) || null,
    previous_disconnect_reason: coexistence.disconnectReason || null,
    previous_disconnect_at: coexistence.last_error_at || null,
  };
  asset.additionalData = {
    ...additionalData,
    coexistence: {
      ...coexistence,
      ...successProjection,
    },
  };
  COEXISTENCE_ERROR_FIELDS.forEach((field) => delete asset.additionalData.coexistence[field]);
  await asset.save();

  const phoneNumberId = phoneId || asset.phoneNumberId || null;
  const resolvedWabaId = wabaId || asset.wabaId || null;
  await mirrorWabaCoexistenceStatus({
    wabaId: resolvedWabaId,
    patch: successProjection,
    clearErrorFields: true,
  });
  const notifications = await markCoexistenceNotificationsRead({
    phoneNumberId,
    wabaId: resolvedWabaId,
  });

  try {
    const resolvedClinicId = Number(clinicId || asset.clinicaId || 0) || null;
    const clinic = resolvedClinicId && Clinica
      ? await Clinica.findByPk(resolvedClinicId, {
          attributes: ['id_clinica', 'nombre_clinica'],
          raw: true,
        })
      : null;

    await notificationService.dispatchEvent({
      event: 'whatsapp.coexistence_reconnected',
      clinicId: resolvedClinicId,
      data: {
        clinicId: resolvedClinicId,
        clinicName: cleanString(clinic?.nombre_clinica),
        phoneNumberId,
        wabaId: resolvedWabaId,
        phoneNumber: cleanString(asset.displayPhoneNumber || asset.display_phone_number || asset.metaAssetName),
        source: cleanString(source) || null,
        messageId: messageId || null,
        link: buildReconnectLink({ phoneNumberId, wabaId: resolvedWabaId }),
        useRouter: true,
      },
    });
  } catch (notificationError) {
    console.warn('[whatsapp] No se pudo crear notificación de reconexión coexistence', {
      clinicId,
      phoneId,
      wabaId,
      messageId,
      error: notificationError?.message || notificationError,
    });
  }

  return { cleared: true, asset_id: asset.id, notifications_read: notifications.count };
}

module.exports = {
  GRAPH_OBJECT_ACCESS_ERROR_CODE,
  GRAPH_OBJECT_ACCESS_ERROR_SUBCODE: GRAPH_OBJECT_ACCESS_ERROR_SUBCODE,
  normalizeProviderError,
  isGraphObjectAccessError,
  isDisconnectedCoexistence,
  mirrorWabaCoexistenceStatus,
  markCoexistenceNotificationsRead,
  markDisconnectedAfterProviderError,
  clearDisconnectedAfterSuccess,
};
