'use strict';

const db = require('../../models');

const {
  ClinicMetaAsset,
  Clinica,
  WhatsappChannelBinding,
} = db;
const PAYMENT_MISSING_ERROR_CODE = 131042;
const PAYMENT_MISSING_MESSAGE = 'WhatsApp no ha podido cobrar este envío. Añade o revisa el método de pago de la cuenta en WhatsApp Manager antes de volver a intentarlo.';

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

const PURPOSE_LABELS = Object.freeze({
  bulk_campaigns: 'los envíos masivos',
  review_requests: 'las solicitudes de reseña',
  lead_first_contact: 'los primeros contactos automáticos a leads',
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function formatPurposeConsequences(purposes = [], unavailableAction = 'pause') {
  const labels = [...new Set((Array.isArray(purposes) ? purposes : [])
    .map((purpose) => PURPOSE_LABELS[cleanString(purpose).toLowerCase()])
    .filter(Boolean))];
  if (!labels.length) return 'No se enviarán mensajes automáticos que dependan de este número.';
  const joined = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
  return cleanString(unavailableAction).toLowerCase() === 'fallback_primary'
    ? `Mientras esté bloqueado, ${joined} se intentarán enviar por el WhatsApp principal configurado.`
    : `Mientras esté bloqueado, no se enviarán ${joined}.`;
}

function parseDateMs(value) {
  const ms = Date.parse(value || '');
  return Number.isNaN(ms) ? 0 : ms;
}

function hasMissingPaymentMarker(payment = {}) {
  return cleanString(payment.status).toLowerCase() === 'missing_payment_method'
    || Number(payment.last_error_code || 0) === PAYMENT_MISSING_ERROR_CODE;
}

function derivePaymentSnapshot(additionalData = {}) {
  const payment = additionalData?.payment && typeof additionalData.payment === 'object'
    ? additionalData.payment
    : {};
  const lastDetectedMs = parseDateMs(payment.last_detected_at);
  const lastSuccessMs = parseDateMs(payment.last_success_at);
  const marker = hasMissingPaymentMarker(payment);
  const clearedByLaterSuccess = marker && lastSuccessMs > 0 && (!lastDetectedMs || lastSuccessMs >= lastDetectedMs);
  const missing = marker && !clearedByLaterSuccess;
  const rawStatus = cleanString(payment.status) || null;

  return {
    status: missing ? 'missing_payment_method' : (rawStatus === 'missing_payment_method' ? 'active' : rawStatus),
    missing,
    last_error_code: missing ? payment.last_error_code || PAYMENT_MISSING_ERROR_CODE : null,
    last_error_message: missing ? PAYMENT_MISSING_MESSAGE : null,
    last_error_href: missing ? payment.last_error_href || null : null,
    last_detected_at: missing ? payment.last_detected_at || null : null,
    last_success_at: payment.last_success_at || null,
  };
}

async function findWhatsappPhoneAssetForMetadata({ phoneId = null, wabaId = null, clinicId = null } = {}) {
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
    const asset = await ClinicMetaAsset.findOne({
      where: { ...baseWhere, clinicaId: clinicId },
      order: [['updatedAt', 'DESC']],
    });
    if (asset) return asset;
  }

  return null;
}

async function clearMissingPaymentAfterSuccessfulStatus({
  clinicId = null,
  phoneId = null,
  wabaId = null,
  messageId = null,
  wamid = null,
  status = null,
  reason = 'whatsapp_success_status',
} = {}) {
  const asset = await findWhatsappPhoneAssetForMetadata({ phoneId, wabaId, clinicId });
  if (!asset) return { cleared: false, reason: 'asset_not_found' };

  const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
    ? { ...asset.additionalData }
    : {};
  const payment = additionalData.payment && typeof additionalData.payment === 'object'
    ? { ...additionalData.payment }
    : {};

  if (!hasMissingPaymentMarker(payment)) {
    return { cleared: false, reason: 'no_missing_marker' };
  }

  const failedMessageId = Number(payment.last_message_id || 0);
  const successfulMessageId = Number(messageId || 0);
  if (
    Number.isInteger(failedMessageId)
    && failedMessageId > 0
    && (!Number.isInteger(successfulMessageId) || successfulMessageId <= failedMessageId)
  ) {
    return { cleared: false, reason: 'success_precedes_payment_failure' };
  }

  const now = new Date().toISOString();
  additionalData.payment = {
    ...payment,
    status: 'active',
    last_success_at: now,
    last_success_status: status || null,
    last_success_reason: reason,
    last_success_message_id: messageId || null,
    last_success_wamid: wamid || null,
    previous_missing_error_code: payment.last_error_code || null,
    previous_missing_detected_at: payment.last_detected_at || null,
  };
  delete additionalData.payment.last_error_code;
  delete additionalData.payment.last_error_message;
  delete additionalData.payment.last_error_href;
  delete additionalData.payment.last_detected_at;
  delete additionalData.payment.last_message_id;
  delete additionalData.payment.last_wamid;

  asset.additionalData = additionalData;
  await asset.save();
  return { cleared: true, asset_id: asset.id };
}

function extractProviderErrorCode(error) {
  const raw = error?.response?.data || error || {};
  const nested = raw?.error?.error
    || raw?.error
    || (Array.isArray(raw?.errors) ? raw.errors[0] : null)
    || raw;
  return Number(
    nested?.code
    || nested?.error_code
    || nested?.error_subcode
    || nested?.error_data?.code
    || 0
  ) || null;
}

async function paymentNotificationScopes(asset, fallbackClinicId = null) {
  const scopes = [];
  if (WhatsappChannelBinding && asset?.id) {
    const bindings = await WhatsappChannelBinding.findAll({
      where: { asset_id: asset.id, is_active: true },
      attributes: ['clinic_id', 'role', 'purposes', 'unavailable_action'],
      raw: true,
    });
    for (const binding of bindings) {
      const clinicId = Number(binding.clinic_id || 0) || null;
      if (!clinicId) continue;
      scopes.push({
        clinicId,
        role: cleanString(binding.role).toLowerCase() || 'primary',
        purposes: Array.isArray(binding.purposes) ? binding.purposes : [],
        unavailableAction: cleanString(binding.unavailable_action).toLowerCase() || 'pause',
      });
    }
  }
  const assetClinicId = Number(asset?.clinicaId || 0) || null;
  const fallback = Number(fallbackClinicId || 0) || assetClinicId;
  if (fallback && !scopes.some((scope) => scope.clinicId === fallback)) {
    scopes.push({ clinicId: fallback, role: 'primary', purposes: [], unavailableAction: 'pause' });
  }
  return scopes;
}

async function dispatchPaymentMissingNotifications({ asset, clinicId = null, messageId = null, wamid = null } = {}) {
  if (!asset) return { notified_scopes: 0 };
  const notificationService = require('./notifications.service');
  const scopes = await paymentNotificationScopes(asset, clinicId);
  for (const scope of scopes) {
    const clinic = Clinica
      ? await Clinica.findByPk(scope.clinicId, { attributes: ['nombre_clinica'], raw: true })
      : null;
    const consequence = formatPurposeConsequences(scope.purposes, scope.unavailableAction);
    await notificationService.dispatchEvent({
      event: 'whatsapp.payment_missing',
      clinicId: scope.clinicId,
      data: {
        clinicId: scope.clinicId,
        clinicName: cleanString(clinic?.nombre_clinica),
        phoneNumber: cleanString(
          asset.additionalData?.display_phone_number
          || asset.additionalData?.phone_number
          || asset.metaAssetName
        ),
        phoneNumberId: asset.phoneNumberId || null,
        wabaId: asset.wabaId || null,
        assetId: asset.id,
        channelRole: scope.role,
        affectedPurposes: scope.purposes,
        unavailableAction: scope.unavailableAction,
        consequence,
        messageId,
        wamid,
        errorCode: PAYMENT_MISSING_ERROR_CODE,
        errorMessage: PAYMENT_MISSING_MESSAGE,
        settingsHref: '/ajustes?tab=whatsapp',
      },
    });
  }
  return { notified_scopes: scopes.length };
}

async function markMissingPaymentFromProviderError({
  error,
  clinicId = null,
  phoneId = null,
  wabaId = null,
  messageId = null,
  wamid = null,
  source = 'whatsapp_provider_error',
} = {}) {
  const errorCode = extractProviderErrorCode(error);
  if (errorCode !== PAYMENT_MISSING_ERROR_CODE) {
    return { marked: false, reason: 'not_missing_payment', error_code: errorCode };
  }
  const asset = await findWhatsappPhoneAssetForMetadata({ phoneId, wabaId, clinicId });
  if (!asset) return { marked: false, reason: 'asset_not_found', error_code: errorCode };

  const additionalData = asset.additionalData && typeof asset.additionalData === 'object'
    ? { ...asset.additionalData }
    : {};
  const payment = additionalData.payment && typeof additionalData.payment === 'object'
    ? { ...additionalData.payment }
    : {};
  const now = new Date().toISOString();
  additionalData.payment = {
    ...payment,
    status: 'missing_payment_method',
    last_error_code: PAYMENT_MISSING_ERROR_CODE,
    last_error_message: PAYMENT_MISSING_MESSAGE,
    last_detected_at: now,
    last_message_id: messageId || null,
    last_wamid: wamid || null,
    last_source: source,
  };
  asset.additionalData = additionalData;
  await asset.save();
  return { marked: true, asset_id: asset.id, error_code: errorCode };
}

async function reconcileProviderStatus({
  status,
  message,
  clinicId = null,
  source = 'whatsapp_status',
} = {}) {
  const messageRow = message?.get ? message.get({ plain: true }) : asObject(message);
  const metadata = asObject(messageRow.metadata);
  const normalizedStatus = cleanString(status?.status || messageRow.status).toLowerCase();
  const phoneId = cleanString(
    metadata.phoneNumberId
    || metadata.phoneId
    || metadata.phone_number_id
  ) || null;
  const wabaId = cleanString(metadata.wabaId || metadata.waba_id) || null;
  const wamid = cleanString(metadata.wamid) || null;

  if (['sent', 'delivered', 'read'].includes(normalizedStatus)) {
    const cleared = await clearMissingPaymentAfterSuccessfulStatus({
      clinicId,
      phoneId,
      wabaId,
      messageId: messageRow.id,
      wamid,
      status: normalizedStatus,
      reason: source,
    });
    if (cleared.cleared) {
      await require('./whatsappAccountHealth.service').recordObservationForAsset({
        assetId: cleared.asset_id,
        signal: { providerStatus: 'CONNECTED' },
        source: `${source}_payment_recovered`,
        explicitRecovery: true,
        dedupeIdentity: `message:${messageRow.id}:${normalizedStatus}:payment-recovered`,
        details: { messageId: messageRow.id },
      });
    }
    return { handled: cleared.cleared, status: normalizedStatus, ...cleared };
  }

  if (normalizedStatus !== 'failed') return { handled: false, reason: 'status_not_relevant' };
  const error = { errors: Array.isArray(status?.errors) ? status.errors : metadata.wa_error || [] };
  const marked = await markMissingPaymentFromProviderError({
    error,
    clinicId,
    phoneId,
    wabaId,
    messageId: messageRow.id,
    wamid,
    source,
  });
  if (!marked.marked) return { handled: false, ...marked };

  const asset = await ClinicMetaAsset.findByPk(marked.asset_id);
  await require('./whatsappAccountHealth.service').recordProviderFailure({
    clinicConfig: {
      originId: marked.asset_id,
      phoneNumberId: phoneId,
      wabaId,
      clinicaId: clinicId,
    },
    error,
    source,
    messageId: messageRow.id,
  });
  const notification = await dispatchPaymentMissingNotifications({
    asset,
    clinicId,
    messageId: messageRow.id,
    wamid,
  });
  return { handled: true, ...marked, ...notification };
}

module.exports = {
  PAYMENT_MISSING_ERROR_CODE,
  PAYMENT_MISSING_MESSAGE,
  clearMissingPaymentAfterSuccessfulStatus,
  dispatchPaymentMissingNotifications,
  derivePaymentSnapshot,
  findWhatsappPhoneAssetForMetadata,
  formatPurposeConsequences,
  markMissingPaymentFromProviderError,
  reconcileProviderStatus,
};
