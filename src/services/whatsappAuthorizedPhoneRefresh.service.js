'use strict';

function createService({
  broker = require('../lib/whatsappAuthorizedBrokerClient'),
  healthService = require('./whatsappAccountHealth.service'),
  now = () => new Date(),
} = {}) {
  async function refresh({ asset, clinicId }) {
    if (!asset || !Number.isInteger(Number(asset.id)) || Number(asset.id) <= 0
      || !Number.isInteger(Number(clinicId)) || Number(clinicId) <= 0) {
      throw Object.assign(new Error('whatsapp_authorized_refresh_invalid'), { code: 'whatsapp_authorized_refresh_invalid' });
    }
    const previousHealth = healthService.summarizeAssetHealth(asset);
    let profile;
    const expectedIdentity = { whatsappAuthorizationId: asset.whatsappAuthorizationId || null,
      phoneNumberId: asset.phoneNumberId, wabaId: asset.wabaId };
    try {
      profile = await broker.profile(Number(clinicId), Number(asset.id));
    } catch (error) {
      if (error?.code !== 'whatsapp_authorized_phone_unavailable') throw error;
      const result = await healthService.recordObservationForAsset({
        assetId: asset.id, expectedIdentity,
        signal: { phoneUnavailable: true },
        source: 'whatsapp_authorized_profile_refresh', observedAt: now(), previousHealth,
      });
      if (!result) throw Object.assign(new Error('whatsapp_authorized_binding_changed'), { code: 'whatsapp_authorized_binding_changed' });
      return { profile: null, health: result.health };
    }
    const observedAt = now();
    const connected = profile.status === 'CONNECTED';
    const profilePatch = { ...profile, authorizedProfileObservedAt: observedAt.toISOString(), registration: {
      status: connected ? 'registered' : 'pending',
      phoneStatus: profile.status,
      codeVerificationStatus: profile.codeVerificationStatus,
    } };
    const health = await healthService.recordObservationForAsset({
      assetId: asset.id,
      expectedIdentity,
      profilePatch,
      signal: {
        providerStatus: profile.status,
        registrationStatus: connected ? 'registered' : 'pending',
        qualityRating: profile.qualityRating,
      },
      source: 'whatsapp_authorized_profile_refresh',
      observedAt,
      previousHealth,
    });
    if (!health) throw Object.assign(new Error('whatsapp_authorized_binding_changed'), { code: 'whatsapp_authorized_binding_changed' });
    return { profile, health: health.health };
  }
  return Object.freeze({ refresh });
}

module.exports = { createService, ...createService() };
