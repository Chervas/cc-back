'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE ClinicMetaAssets
      DROP INDEX clinic_meta_assets_meta_connection_id_meta_asset_id
    `).catch(() => {});

    await queryInterface.sequelize.query(`
      ALTER TABLE ClinicMetaAssets
      DROP INDEX uniq_meta_connection_asset
    `).catch(() => {});
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE ClinicMetaAssets
      ADD UNIQUE INDEX clinic_meta_assets_meta_connection_id_meta_asset_id (metaConnectionId, metaAssetId)
    `).catch(() => {});
  }
};
