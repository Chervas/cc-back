'use strict';

const { Op, fn, col, where } = require('sequelize');
const { assertSharedMarketingAssetMutationAccess } = require('./sharedMarketingAssetMutationAccess');

async function assertGoogleConversionMutationAccess({ userId, customerId, runtimeAccountId, models = require('../../models'),
  assertAssetAccess = assertSharedMarketingAssetMutationAccess }) {
  const customer = String(customerId || '').replace(/-/g, '');
  if (!/^\d{10}$/.test(customer)) throw Object.assign(new Error('Invalid Google Ads account'), { code: 'invalid_customer_id', httpStatus: 400 });
  // A conversion action belongs to the whole ad account, including its other clinic mappings.
  const mappings = await models.ClinicGoogleAdsAccount.findAll({ where: { isActive: true,
    [Op.and]: [where(fn('REPLACE', col('customerId'), '-', ''), customer)] },
    attributes: ['id', 'clinicaId'], raw: true });
  if (!mappings.some(row => Number(row.id) === Number(runtimeAccountId))) {
    throw Object.assign(new Error('Google Ads account mapping changed'), { code: 'google_ads_account_mapping_changed', httpStatus: 409 });
  }
  for (const mapping of mappings) {
    await assertAssetAccess({ userId, assetType: 'google.ads_account', assetId: mapping.id,
      ownerClinicId: mapping.clinicaId, assignmentModel: models.GroupAssetClinicAssignment });
  }
}

module.exports = { assertGoogleConversionMutationAccess };
