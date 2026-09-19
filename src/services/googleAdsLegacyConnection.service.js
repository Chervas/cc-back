'use strict';
const legacy = require('./googleLegacyCredentials.service');
// Preserve the caller's transaction/row lock for identity metadata. Credential
// reads use the guarded, current SQL statement outside an older scope snapshot.
async function loadGoogleAdsLegacyConnection(models, connectionId, options = {}) {
  try {
    const metadata = await models.GoogleConnection.findByPk(connectionId, {
      ...options, attributes: ['id', 'googleUserId'], raw: true, logging: false,
    });
    if (!metadata || Number(metadata.id) !== Number(connectionId) || typeof metadata.googleUserId !== 'string' || !metadata.googleUserId) {
      throw Object.assign(Error('google_connection_missing'), { code: 'google_connection_missing', httpStatus: 409 });
    }
    return await legacy.forModels(models).load(connectionId, { includeScopes: true, expectedSubject: metadata.googleUserId });
  } catch (error) {
    const code = legacy.safe(error);
    throw Object.assign(Error(code), { code, httpStatus: 409 });
  }
}
function guardGoogleAdsLegacyRequest(connection, request, credentials = legacy) {
  // Capture immutable identity; callers may mutate their cached ORM instance.
  const identity = { id: connection?.id, googleUserId: connection?.googleUserId };
  return (...args) => credentials.request(identity, () => request(...args));
}
module.exports = { loadGoogleAdsLegacyConnection, guardGoogleAdsLegacyRequest };
