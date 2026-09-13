'use strict';
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
// Business-contract fixtures still exercise the actual credential boundary.
// Registries are empty fictitious tables; security races use the stricter
// google_legacy_credentials.fixture and actual isolated MySQL separately.
function installGoogleAdsLegacyModels(models) {
  const original = models.GoogleConnection.findByPk;
  models.GoogleConnection.findByPk = async (id, options) => {
    assert.deepEqual(options.attributes, ['id', 'googleUserId']);
    const row = await original(id, options);
    return row && { id: row.id, googleUserId: row.googleUserId };
  };
  models.GoogleConnection.findOne = async options => {
    assert.match(options.where[Op.and].val, /GooglePropertyBrokerRevocations/);
    assert.equal(options.transaction, undefined);
    const row = await original(options.where.id, options);
    return row && row.googleUserId === options.where.googleUserId ? row : null;
  };
  for (const name of ['GoogleOAuthBrokerBinding', 'SearchConsoleBrokerBinding', 'AnalyticsBrokerBinding', 'GooglePropertyBrokerRevocation', 'GoogleAdsBrokerBinding']) {
    models[name] = { findOne: async options => {
      assert.deepEqual(options.attributes, ['google_user_id']);
      assert.equal(options.transaction, undefined); return null;
    } };
  }
  return models;
}
module.exports = { installGoogleAdsLegacyModels };
