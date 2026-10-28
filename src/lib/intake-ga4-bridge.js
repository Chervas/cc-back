'use strict';

const validId = value => typeof value === 'string' && /^G-[A-Z0-9]{4,32}$/.test(value);
function ga4BridgeError(features = {}) {
  if (features.ga4_bridge_enabled != null && typeof features.ga4_bridge_enabled !== 'boolean') return 'ga4_bridge_invalid';
  if (features.ga4_measurement_id != null && features.ga4_measurement_id !== '' && !validId(features.ga4_measurement_id)) return 'ga4_measurement_id_invalid';
  if (features.ga4_bridge_enabled === true && (!validId(features.ga4_measurement_id) || features.consent_mode_enabled !== true)) return 'ga4_bridge_requires_consent_and_destination';
  return null;
}
function bridgeStatus(features = {}) {
  return features.ga4_bridge_enabled === true && !ga4BridgeError(features) ? 'configured' : 'not_configured';
}
module.exports = { ga4BridgeError, bridgeStatus };
