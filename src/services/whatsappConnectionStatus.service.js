'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const notificationService = require('./notifications.service');

const { ClinicMetaAsset, Clinica } = db;

const GRAPH_OBJECT_ACCESS_ERROR_CODE = 100;
const GRAPH_OBJECT_ACCESS_ERROR_SUBCODE = 33;

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

  if (asset) {
    const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
      ? { ...asset.additionalData }
      : {};
    const coexistence = additionalData.coexistence && typeof additionalData.coexistence === 'object'
      ? { ...additionalData.coexistence }
      : {};
    const registration = additionalData.registration && typeof additionalData.registration === 'object'
      ? { ...additionalData.registration }
      : {};

    asset.additionalData = {
      ...additionalData,
      coexistence: {
        ...coexistence,
        status: 'disconnected',
        canSendApi: false,
        requiresReconnect: true,
        disconnectReason: 'meta_object_access_lost',
        last_error_code: normalized.code,
        last_error_subcode: normalized.subcode,
        last_error_message: normalized.message,
        last_error_at: now,
        last_message_id: messageId || null,
        last_recipient: cleanString(recipient) || null,
        last_source: cleanString(source) || null,
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

  try {
    const clinic = resolvedClinicId && Clinica
      ? await Clinica.findByPk(resolvedClinicId, {
          attributes: ['id_clinica', 'nombre_clinica'],
          raw: true,
        })
      : null;

    const phoneNumberId = phoneId || asset?.phoneNumberId || null;
    const resolvedWabaId = wabaId || asset?.wabaId || null;

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
  if (coexistence.status !== 'disconnected' && coexistence.requiresReconnect !== true) {
    return { cleared: false, reason: 'no_disconnect_marker' };
  }

  asset.additionalData = {
    ...additionalData,
    coexistence: {
      ...coexistence,
      status: 'active',
      canSendApi: true,
      requiresReconnect: false,
      last_success_at: new Date().toISOString(),
      last_success_message_id: messageId || null,
      last_success_source: cleanString(source) || null,
      previous_disconnect_reason: coexistence.disconnectReason || null,
      previous_disconnect_at: coexistence.last_error_at || null,
    },
  };
  delete asset.additionalData.coexistence.last_error_code;
  delete asset.additionalData.coexistence.last_error_subcode;
  delete asset.additionalData.coexistence.last_error_message;
  delete asset.additionalData.coexistence.last_error_at;
  delete asset.additionalData.coexistence.last_message_id;
  delete asset.additionalData.coexistence.last_recipient;
  delete asset.additionalData.coexistence.last_source;
  await asset.save();
  return { cleared: true, asset_id: asset.id };
}

module.exports = {
  GRAPH_OBJECT_ACCESS_ERROR_CODE,
  GRAPH_OBJECT_ACCESS_ERROR_SUBCODE: GRAPH_OBJECT_ACCESS_ERROR_SUBCODE,
  normalizeProviderError,
  isGraphObjectAccessError,
  markDisconnectedAfterProviderError,
  clearDisconnectedAfterSuccess,
};
