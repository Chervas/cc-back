'use strict';

const MIN_AGE_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
function availability({ asset, health, now = new Date() } = {}) {
  const row = asset?.get ? asset.get({ plain: true }) : asset;
  const payment = row?.additionalData?.payment || {};
  const nowMs = new Date(now).getTime(), failure = Date.parse(payment.last_detected_at || '');
  const lastProbe = Date.parse(payment.last_probe_at || '');
  const recovery = health?.state === 'blocked' && health?.reason_code === 'meta_error_131042_payment_missing'
    && Number(payment.last_error_code) === 131042 && payment.status === 'missing_payment_method';
  const unknown = !payment.status || payment.status === 'unknown';
  const configuration = (row?.isActive === true || row?.isActive === 1)
    && health?.state === 'healthy' && health?.can_send === true && !health?.is_stale
    && unknown && !payment.last_success_at && !payment.last_error_code;
  if (row?.isActive === false || row?.isActive === 0 || row?.additionalData?.routing_disabled
    || row?.additionalData?.whatsappArchive?.archivedAt
    || row?.additionalData?.whatsappManualDisconnect
    || String(health?.provider_status || '').toUpperCase() !== 'CONNECTED'
    || !recovery && !configuration) {
    return { allowed: false, reason: 'payment_probe_not_applicable' };
  }
  if (configuration && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.whatsappAuthorizationId || '')) {
    return { allowed: false, reason: 'payment_probe_configuration_unsupported' };
  }
  if (!Number.isFinite(nowMs) || recovery && (!Number.isFinite(failure) || nowMs - failure < MIN_AGE_MS)) {
    return { allowed: false, reason: 'payment_probe_failure_too_recent',
      ...(Number.isFinite(failure) && Number.isFinite(nowMs)
        ? { retry_after_seconds: Math.max(1, Math.ceil((failure + MIN_AGE_MS - nowMs) / 1000)) } : {}) };
  }
  if (Number.isFinite(lastProbe) && nowMs - lastProbe < COOLDOWN_MS) {
    return { allowed: false, reason: 'payment_probe_cooldown', retry_after_seconds: Math.ceil((lastProbe + COOLDOWN_MS - nowMs) / 1000) };
  }
  return { allowed: true, reason: 'payment_probe_available' };
}

module.exports = { availability, MIN_AGE_MS, COOLDOWN_MS };
