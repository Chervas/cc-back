'use strict';

async function safeRemoveIndex(queryInterface, tableName, indexName) {
  try {
    await queryInterface.removeIndex(tableName, indexName);
  } catch (_error) {
    // ignore
  }
}

async function safeRemoveConstraint(queryInterface, tableName, constraintName) {
  try {
    await queryInterface.removeConstraint(tableName, constraintName);
  } catch (_error) {
    // ignore
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await safeRemoveConstraint(queryInterface, 'ClinicMetaAssets', 'uniq_meta_connection_asset');
    await safeRemoveConstraint(queryInterface, 'ClinicMetaAssets', 'clinic_meta_assets_meta_connection_id_meta_asset_id');
    await safeRemoveIndex(queryInterface, 'ClinicMetaAssets', 'uniq_meta_connection_asset');
    await safeRemoveIndex(queryInterface, 'ClinicMetaAssets', 'clinic_meta_assets_meta_connection_id_meta_asset_id');

    try {
      await queryInterface.addConstraint('ClinicMetaAssets', {
        fields: ['clinicaId', 'assetType', 'metaAssetId'],
        type: 'unique',
        name: 'unique_clinic_asset'
      });
    } catch (_error) {
      // ignore if already exists
    }
  },

  async down(queryInterface, Sequelize) {
    await safeRemoveConstraint(queryInterface, 'ClinicMetaAssets', 'unique_clinic_asset');
    await safeRemoveIndex(queryInterface, 'ClinicMetaAssets', 'unique_clinic_asset');

    try {
      await queryInterface.addConstraint('ClinicMetaAssets', {
        fields: ['metaConnectionId', 'metaAssetId'],
        type: 'unique',
        name: 'uniq_meta_connection_asset'
      });
    } catch (_error) {
      // ignore if already exists
    }
  }
};
