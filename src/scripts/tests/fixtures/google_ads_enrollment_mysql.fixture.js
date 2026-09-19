'use strict';
// Call only inside withIsolatedCampaignMysql; never bootstrap application models.
async function installGoogleAdsEnrollmentTables({ sql, models }) {
  const D = require('sequelize').DataTypes;
  await require('../../../../migrations/20260913120000-create-google-ads-enrollment').up(sql.getQueryInterface());
  models.GoogleAdsEnrollmentScope = require('../../../../models/googleadsenrollmentscope')(sql, D);
  models.GoogleAdsEnrollmentRequest = require('../../../../models/googleadsenrollmentrequest')(sql, D);
}
module.exports = { installGoogleAdsEnrollmentTables };
