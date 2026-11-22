'use strict';

const C = require('./whatsapp-authorized-contract');
const E = require('./whatsapp-onboarding-contract');
const { BrokerError, fail } = require('./errors');
const { profilePictureUrl } = require('./whatsapp-profile-picture');

const READ = 'meta.whatsapp.authorized.profile.read.v1';
const STATUSES = ['CONNECTED', 'DISCONNECTED', 'BANNED', 'MIGRATED', 'PENDING', 'DELETED'];
const VERIFICATION_STATUSES = ['VERIFIED', 'NOT_VERIFIED', 'EXPIRED'];
const QUALITY_RATINGS = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN', 'NA'];
const PLATFORM_TYPES = ['CLOUD_API', 'ON_PREMISE', 'NOT_APPLICABLE'];

function validate(payload) {
  const withPicture = Object.hasOwn(payload || {}, 'includeProfilePicture');
  if (!C.keys(payload, ['authorizationId', 'phoneId', ...(withPicture ? ['includeProfilePicture'] : [])])
    || (withPicture && payload.includeProfilePicture !== true)
    || !E.uuid(payload.authorizationId) || !E.id(payload.phoneId)) fail('invalid_request');
  return payload;
}

function optionalText(value, max) {
  return value === undefined || value === null
    ? null
    : typeof value === 'string' && value.length > 0 && value.length <= max
      ? value
      : fail('provider_failed');
}

function optionalEnum(value, allowed) {
  return value === undefined || value === null
    ? null
    : allowed.includes(value)
      ? value
      : fail('provider_failed');
}

function requiredEnum(value, allowed) {
  return allowed.includes(value) ? value : fail('provider_failed');
}

function project(raw) {
  if (!raw || raw.error || !E.id(raw.id)) fail('provider_failed');
  const isOnBizApp = raw.isOnBizApp ?? raw.is_on_biz_app ?? null;
  if (isOnBizApp !== null && typeof isOnBizApp !== 'boolean') fail('provider_failed');
  const picture = profilePictureUrl(raw.profilePictureUrl, { providerOnly: true });
  return {
    id: raw.id,
    status: requiredEnum(raw.status, STATUSES),
    codeVerificationStatus: optionalEnum(raw.codeVerificationStatus ?? raw.code_verification_status, VERIFICATION_STATUSES),
    qualityRating: optionalEnum(raw.qualityRating ?? raw.quality_rating, QUALITY_RATINGS),
    isOnBizApp,
    platformType: optionalEnum(raw.platformType ?? raw.platform_type, PLATFORM_TYPES),
    displayPhoneNumber: optionalText(raw.displayPhoneNumber ?? raw.display_phone_number, 64),
    verifiedName: optionalText(raw.verifiedName ?? raw.verified_name, 256),
    ...(picture ? { profilePictureUrl: picture } : {}),
  };
}

function operation({ http, secrets, registry }) {
  return Object.freeze({
    provider: C.PROVIDER,
    effect: 'read',
    persistResult: false,
    validate,
    authorize: input => registry.authorize(input),
    project,
    async execute({ payload, binding, secret, signal, assertActive }) {
      const value = registry.assert(binding);
      if (payload.authorizationId !== value.definition.authorizationId
        || payload.phoneId !== value.definition.phoneId) fail('scope_denied');
      assertActive();
      const proof = secrets.proof(secret, binding.connectionRef);
      const read = (action, signal) => http({
        action,
        id: payload.phoneId,
        token: secret,
        proof,
        signal,
      });
      const profile = project(await read('profile', signal));
      assertActive();
      registry.assert(binding);
      if (profile.id !== payload.phoneId) fail('provider_failed');
      if (!payload.includeProfilePicture || profile.status !== 'CONNECTED') return profile;

      // An unavailable or slow optional photo may not erase the saved photo
      // or change the independently observed sending status.
      const deadline = AbortSignal.timeout(3000);
      const pictureSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const remote = await read('profile_picture', pictureSignal);
        const picture = Array.isArray(remote?.data) && remote.data.length === 1
          ? profilePictureUrl(remote.data[0]?.profile_picture_url, { providerOnly: true })
          : null;
        if (picture && !picture.includes(proof) && !picture.includes(secret.toString('utf8'))) {
          profile.profilePictureUrl = picture;
        }
      } catch (error) {
        const optionalProviderFailure = error instanceof BrokerError
          && (['provider_timeout', 'provider_failed', 'provider_unauthorized', 'credential_revoked'].includes(error.code)
            || /^whatsapp_provider_[0-9]+$/.test(error.code));
        if (!optionalProviderFailure) throw error;
      }
      assertActive();
      registry.assert(binding);
      return profile;
    },
  });
}

module.exports = { READ, validate, project, operation };
