'use strict';

const db = require('../../models');

const { ClinicMetaAsset } = db;
const PAYMENT_MISSING_ERROR_CODE = 131042;

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
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
    last_error_message: missing ? payment.last_error_message || null : null,
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

module.exports = {
  PAYMENT_MISSING_ERROR_CODE,
  clearMissingPaymentAfterSuccessfulStatus,
  derivePaymentSnapshot,
  findWhatsappPhoneAssetForMetadata,
};
