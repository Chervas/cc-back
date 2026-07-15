'use strict';

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function evaluateMetaConnectionHealth(connection, debugData, {
  nowMs = Date.now(),
  expectedAppId = null,
} = {}) {
  const storedExpiryMs = timestampMs(connection?.expiresAt);
  if (storedExpiryMs === null) {
    return { connected: false, reason: 'token_expiry_unknown', reauthorizationRequired: true };
  }
  if (storedExpiryMs <= nowMs) {
    return { connected: false, reason: 'token_expired', reauthorizationRequired: true };
  }
  if (!debugData || debugData.is_valid !== true) {
    return { connected: false, reason: 'token_invalid', reauthorizationRequired: true };
  }
  if (expectedAppId && debugData.app_id && String(debugData.app_id) !== String(expectedAppId)) {
    return { connected: false, reason: 'token_app_mismatch', reauthorizationRequired: true };
  }
  const providerExpirySeconds = Number(debugData.expires_at || 0);
  if (providerExpirySeconds > 0 && providerExpirySeconds * 1000 <= nowMs) {
    return { connected: false, reason: 'token_expired', reauthorizationRequired: true };
  }
  const dataAccessExpirySeconds = Number(debugData.data_access_expires_at || 0);
  if (dataAccessExpirySeconds > 0 && dataAccessExpirySeconds * 1000 <= nowMs) {
    return { connected: false, reason: 'data_access_expired', reauthorizationRequired: true };
  }
  return { connected: true, reason: null, reauthorizationRequired: false };
}

module.exports = { evaluateMetaConnectionHealth, timestampMs };
