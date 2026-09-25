'use strict';

function createService({
  broker = require('../lib/whatsappAuthorizedBrokerClient'),
  healthService = require('./whatsappAccountHealth.service'),
  now = () => new Date(),
} = {}) {
  async function refresh({ asset, clinicId }) {
    if (!asset || !Number.isInteger(Number(asset.id)) || Number(asset.id) <= 0
      || !Number.isInteger(Number(clinicId)) || Number(clinicId) <= 0
      || !asset.whatsappAuthorizationId) {
      throw Object.assign(new Error('whatsapp_authorized_refresh_invalid'), { code: 'whatsapp_authorized_refresh_invalid' });
    }
    const previousHealth = healthService.summarizeAssetHealth(asset);
    const profile = await broker.profile(Number(clinicId), Number(asset.id));
    const observedAt = now();
    const connected = profile.status === 'CONNECTED';
    const additionalData = { ...(asset.additionalData || {}) };
    if (profile.platformType !== null) additionalData.platformType = profile.platformType;
    if (profile.isOnBizApp !== null) additionalData.isOnBizApp = profile.isOnBizApp;
    additionalData.registration = {
      ...(additionalData.registration || {}),
      status: connected ? 'registered' : 'pending',
      phoneStatus: profile.status,
      codeVerificationStatus: profile.codeVerificationStatus,
    };
    additionalData.authorizedProfileObservedAt = observedAt.toISOString();
    await asset.update({
      metaAssetName: profile.displayPhoneNumber || asset.metaAssetName,
      waVerifiedName: profile.verifiedName || asset.waVerifiedName,
      quality_rating: profile.qualityRating || asset.quality_rating,
      additionalData,
    });
    const health = await healthService.recordObservationForAsset({
      assetId: asset.id,
      signal: {
        providerStatus: profile.status,
        registrationStatus: connected ? 'registered' : 'pending',
        qualityRating: profile.qualityRating,
      },
      source: 'whatsapp_authorized_profile_refresh',
      observedAt,
      previousHealth,
    });
    return { profile, health: health?.health || null };
  }
  return Object.freeze({ refresh });
}

module.exports = { createService, ...createService() };
