'use strict';
const { createHash } = require('node:crypto');
const { positive } = require('../../services/platform-audit/src/integration-disconnect-event');
const oauth = require('../../services/integrations-broker/src/google-oauth-contract');
const COHORTS = Object.freeze({
  business_profile: { provider: 'google_business_profile', asset: /^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/, gate: 'GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED' },
  search_console: { provider: 'google_search_console', asset: /^sc:[a-f0-9]{64}$/, gate: 'GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED' },
  analytics: { provider: 'google_analytics', asset: /^ga4:[1-9]\d{0,19}$/, gate: 'GOOGLE_ANALYTICS_BROKER_ENABLED' },
  ads: { provider: 'google_ads', asset: /^ads:(?!0000000000$)\d{10}$/, gate: 'GOOGLE_ADS_BROKER_ENABLED' },
});
const LEGACY_POLICY = 'google-oauth-pinned-v1'; const POLICY = 'google-oauth-cohorts-v1';
const BASE_FIELDS = ['google_user_id', 'google_connection_id', 'connection_ref', 'asset_ref', 'clinica_id', 'scope_key', 'policy_version'];
const FIELDS = [...BASE_FIELDS, 'cohort'];
const fail = (code = 'google_oauth_scope_conflict', httpStatus = 409) => { throw Object.assign(Error(code), { code, httpStatus }); };
function cohortOf(row) {
  const value = row?.cohort === undefined && row?.policy_version === LEGACY_POLICY ? 'business_profile' : row?.cohort;
  if (!Object.hasOwn(COHORTS, value)) fail(); return value;
}
function requestedScope(value) {
  if (typeof value !== 'string' || !/^(clinic|group):[1-9]\d{0,9}$/.test(value) || !positive(value.split(':')[1])) fail();
  const [type, id] = value.split(':'); return { type, id: Number(id) };
}
function validate(binding) {
  const cohort = cohortOf(binding);
  if (typeof binding.google_user_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(binding.google_user_id) || binding.google_user_id === 'unknown'
    || !positive(String(binding.google_connection_id)) || !positive(String(binding.clinica_id))
    || typeof binding.connection_ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(binding.connection_ref)
    || typeof binding.asset_ref !== 'string' || !COHORTS[cohort].asset.test(binding.asset_ref)) fail();
  if (binding.policy_version === LEGACY_POLICY) {
    if (cohort !== 'business_profile') fail(); requestedScope(binding.scope_key);
  } else if (binding.policy_version !== POLICY || binding.scope_key !== 'connection:' + Number(binding.google_connection_id)) fail();
  return binding;
}
function digest(binding) {
  validate(binding); const fields = binding.policy_version === LEGACY_POLICY ? BASE_FIELDS : FIELDS;
  return createHash('sha256').update(JSON.stringify(fields.map(k => binding[k]))).digest('hex');
}
const keyFor = binding => ({ google_user_id: binding.google_user_id, cohort: cohortOf(binding) });
const operationsFor = binding => oauth.operationsFor(COHORTS[cohortOf(validate(binding))].provider);
module.exports = { COHORTS, POLICY, LEGACY_POLICY, FIELDS, BASE_FIELDS, fail, positive, cohortOf, requestedScope, validate, digest, keyFor, operationsFor };
