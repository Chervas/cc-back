'use strict';

function current(asset, binding) {
  const value = asset?.additionalData?.whatsappManualDisconnect;
  return value && ['pending', 'disconnected'].includes(value.state)
    && value.phoneId === asset.phoneNumberId && value.wabaId === asset.wabaId
    && value.localAuthorizationId === (asset.whatsappAuthorizationId || null)
    && (!binding || value.authorizationId === binding.authorizationId && value.connectionRef === binding.connectionRef)
    ? value : null;
}
module.exports = { current };
