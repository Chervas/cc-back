'use strict';

const C = require('./whatsapp-authorized-contract');
const E = require('./whatsapp-onboarding-contract');
const { fail } = require('./errors');

const READ = 'meta.whatsapp.authorized.profile.read.v1';
const STATUSES = ['CONNECTED', 'DISCONNECTED', 'BANNED', 'MIGRATED', 'PENDING', 'DELETED'];
const VERIFICATION_STATUSES = ['VERIFIED', 'NOT_VERIFIED', 'EXPIRED'];
const QUALITY_RATINGS = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN', 'NA'];
const PLATFORM_TYPES = ['CLOUD_API', 'ON_PREMISE', 'NOT_APPLICABLE'];

function validate(payload) {
  if (!C.keys(payload, ['authorizationId', 'phoneId'])
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
  return {
    id: raw.id,
    status: requiredEnum(raw.status, STATUSES),
    codeVerificationStatus: optionalEnum(raw.codeVerificationStatus ?? raw.code_verification_status, VERIFICATION_STATUSES),
    qualityRating: optionalEnum(raw.qualityRating ?? raw.quality_rating, QUALITY_RATINGS),
    isOnBizApp,
    platformType: optionalEnum(raw.platformType ?? raw.platform_type, PLATFORM_TYPES),
    displayPhoneNumber: optionalText(raw.displayPhoneNumber ?? raw.display_phone_number, 64),
    verifiedName: optionalText(raw.verifiedName ?? raw.verified_name, 256),
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
      const result = await http({
        action: 'profile',
        id: payload.phoneId,
        token: secret,
        proof: secrets.proof(secret, binding.connectionRef),
        signal,
      });
      assertActive();
      registry.assert(binding);
      return project(result);
    },
  });
}

module.exports = { READ, validate, project, operation };
