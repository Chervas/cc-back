'use strict';
// Completion of an existing, immutable Embedded Signup receipt. No caller can
// select a token, provider URL, phone, WABA, role or additional clinic here.
const E = require('./whatsapp-onboarding-contract');
const { fail } = require('./errors');
const PROFILE = 'meta.whatsapp.onboarding.profile.v1';
const ACTIVATE = 'meta.whatsapp.onboarding.activate.v1';
const STATUS = 'meta.whatsapp.onboarding.activation-status.v1';
const OPERATIONS = Object.freeze([PROFILE, ACTIVATE, STATUS]);
const phases = Object.freeze(['prepared','capture_ready','register_requested','registration_uncertain','registration_required','subscribing','provider_pending','active']);
const positive = n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
function validate(payload, operation) {
  const keys = ['flowId', 'scopeDigest', 'clinicSetDigest', ...(operation === ACTIVATE ? ['assetId'] : [])];
  if (!OPERATIONS.includes(operation) || !E.exact(payload, keys) || !E.uuid(payload.flowId)
    || !/^[a-f0-9]{64}$/.test(payload.scopeDigest) || !/^[a-f0-9]{64}$/.test(payload.clinicSetDigest)
    || operation === ACTIVATE && !positive(payload.assetId)) fail('invalid_request');
  return payload;
}
const connectionRef = flowId => { if (!E.uuid(flowId)) fail('invalid_request'); return 'whatsapp-live-' + flowId; };
function profile(raw, expected) {
  if (!raw || raw.id !== expected || !E.id(raw.id)) fail('scope_denied');
  const text = (value, max = 255) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : null;
  return {
    phoneId: raw.id, displayPhoneNumber: text(raw.display_phone_number), verifiedName: text(raw.verified_name),
    status: ['CONNECTED','DISCONNECTED','PENDING','BANNED','MIGRATED','DELETED'].includes(raw.status) ? raw.status : null,
    codeVerificationStatus: ['VERIFIED','NOT_VERIFIED','EXPIRED'].includes(raw.code_verification_status) ? raw.code_verification_status : null,
    qualityRating: ['GREEN','YELLOW','RED','UNKNOWN','NA'].includes(raw.quality_rating) ? raw.quality_rating : null,
    platformType: ['CLOUD_API','ON_PREMISE','NOT_APPLICABLE'].includes(raw.platform_type) ? raw.platform_type : null,
    isOnBizApp: typeof raw.is_on_biz_app === 'boolean' ? raw.is_on_biz_app : null,
  };
}
module.exports = { PROFILE, ACTIVATE, STATUS, OPERATIONS, phases, positive, validate, connectionRef, profile };
