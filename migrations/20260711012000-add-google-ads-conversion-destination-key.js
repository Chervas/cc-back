'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('GoogleAdsConversionUploadAttempts', 'destination_key', {
      type: Sequelize.STRING(128),
      allowNull: true,
      after: 'assignment_scope'
    });
    await queryInterface.addIndex('GoogleAdsConversionUploadAttempts', ['destination_key', 'status', 'attempted_at'], {
      name: 'idx_google_ads_conversion_upload_destination'
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('GoogleAdsConversionUploadAttempts', 'idx_google_ads_conversion_upload_destination');
    await queryInterface.removeColumn('GoogleAdsConversionUploadAttempts', 'destination_key');
  }
};
