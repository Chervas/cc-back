'use strict';
// Metadata-only OAuth WRITE boundary; existing read workers keep their own guards.
const REGISTRIES = Object.freeze([
  ['GoogleOAuthBrokerBinding', 'google_user_id'], ['SearchConsoleBrokerBinding', 'google_user_id'],
  ['AnalyticsBrokerBinding', 'google_user_id'], ['GooglePropertyBrokerRevocation', 'google_user_id'],
  ['GoogleAdsBrokerBinding', 'google_user_id'], ['GoogleAdsBrokerRevocation', 'google_user_id'],
  ['GoogleAdsEnrollmentScope', 'google_user_id'], ['GoogleAdsEnrollmentRequest', 'google_user_id'],
  ['BusinessProfileBrokerBinding', 'external_location_id'], ['BusinessProfileBrokerRevocation', 'external_location_id'],
]);
const fail = (code = 'google_oauth_legacy_closed', httpStatus = 409) => { throw Object.assign(Error(code), { code, httpStatus }); };
function createGoogleLegacyOAuthGuard({ models }) {
  return { async assertAllowed({ transaction } = {}) {
    if (transaction && !transaction.LOCK?.SHARE) fail('google_oauth_unavailable', 503);
    for (const [name, attribute] of REGISTRIES) {
      if (!models?.[name]?.findOne) fail('google_oauth_unavailable', 503);
      // SERIALIZABLE persistence holds these empty-registry range locks through
      // commit. Consumer migration remains a separate coordinated activation.
      const row = await models[name].findOne({ attributes: [attribute], raw: true, logging: false,
        ...(transaction ? { transaction, lock: transaction.LOCK.SHARE } : {}) });
      if (row) fail();
    }
  } };
}
module.exports = { REGISTRIES, createGoogleLegacyOAuthGuard };
