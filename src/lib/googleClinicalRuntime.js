'use strict';
// Only migration-specific activation gates. Existing direct Google integrations
// keep their original configuration until the separate credential/consumer cut.
function assertGoogleClinicalRuntime(env) {
  if (env.AUTH_SESSION_MODE !== 'enforce' || env.AUTH_EMAIL_MFA_MODE !== 'enforce') {
    throw Error('google_schema_runtime_review_required');
  }
  for (const [key,value] of Object.entries(env)) {
    if (/^GOOGLE_.*(?:BROKER|REVOCATION|ENROLLMENT|MAPPING)(?:_WORKER)?_ENABLED$/.test(key)
      && !['','false'].includes(value)) throw Error('google_schema_activation_requires_review');
  }
}
module.exports = { assertGoogleClinicalRuntime };
