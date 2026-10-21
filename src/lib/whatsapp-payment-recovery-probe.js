'use strict';

const MIN_AGE_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
function availability({ asset, health, now = new Date() } = {}) {
  const row = asset?.get ? asset.get({ plain: true }) : asset;
  const payment = row?.additionalData?.payment || {};
  const nowMs = new Date(now).getTime(), failure = Date.parse(payment.last_detected_at || '');
  const lastProbe = Date.parse(payment.last_probe_at || '');
  if (row?.isActive === false || row?.isActive === 0 || row?.additionalData?.routing_disabled
    || row?.additionalData?.whatsappArchive?.archivedAt
    || health?.state !== 'blocked' || health?.reason_code !== 'meta_error_131042_payment_missing'
    || String(health?.provider_status || '').toUpperCase() !== 'CONNECTED'
    || Number(payment.last_error_code) !== 131042 || payment.status !== 'missing_payment_method') {
    return { allowed: false, reason: 'payment_probe_not_applicable' };
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(failure) || nowMs - failure < MIN_AGE_MS) {
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
