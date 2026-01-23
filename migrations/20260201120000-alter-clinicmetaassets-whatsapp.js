'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Extender ENUM de assetType
    await queryInterface.changeColumn('ClinicMetaAssets', 'assetType', {
      type: Sequelize.ENUM('facebook_page', 'instagram_business', 'ad_account', 'whatsapp_business_account', 'whatsapp_phone_number'),
      allowNull: false,
      comment: 'Tipo de activo de Meta',
    });

    await queryInterface.addColumn('ClinicMetaAssets', 'wabaId', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('ClinicMetaAssets', 'phoneNumberId', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('ClinicMetaAssets', 'waVerifiedName', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await queryInterface.addColumn('ClinicMetaAssets', 'quality_rating', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addColumn('ClinicMetaAssets', 'messaging_limit', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addColumn('ClinicMetaAssets', 'waAccessToken', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('ClinicMetaAssets', 'meta_billed_by', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.addIndex('ClinicMetaAssets', ['phoneNumberId'], {
      name: 'idx_clinic_meta_assets_phone_number',
    });
    await queryInterface.addIndex('ClinicMetaAssets', ['wabaId'], {
      name: 'idx_clinic_meta_assets_waba',
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('ClinicMetaAssets', 'idx_clinic_meta_assets_phone_number');
    await queryInterface.removeIndex('ClinicMetaAssets', 'idx_clinic_meta_assets_waba');
    await queryInterface.removeColumn('ClinicMetaAssets', 'wabaId');
    await queryInterface.removeColumn('ClinicMetaAssets', 'phoneNumberId');
    await queryInterface.removeColumn('ClinicMetaAssets', 'waVerifiedName');
    await queryInterface.removeColumn('ClinicMetaAssets', 'quality_rating');
    await queryInterface.removeColumn('ClinicMetaAssets', 'messaging_limit');
    await queryInterface.removeColumn('ClinicMetaAssets', 'waAccessToken');
    await queryInterface.removeColumn('ClinicMetaAssets', 'meta_billed_by');
    await queryInterface.changeColumn('ClinicMetaAssets', 'assetType', {
      type: Sequelize.ENUM('facebook_page', 'instagram_business', 'ad_account'),
      allowNull: false,
      comment: 'Tipo de activo de Meta',
    });
  },
};
