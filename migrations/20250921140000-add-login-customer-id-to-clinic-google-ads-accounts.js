'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'loginCustomerId', {
      type: Sequelize.STRING(32),
      allowNull: true,
      after: 'managerCustomerId'
    });
    await queryInterface.addIndex('ClinicGoogleAdsAccounts', ['loginCustomerId'], {
      name: 'idx_clinic_google_ads_login_customer'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('ClinicGoogleAdsAccounts', 'idx_clinic_google_ads_login_customer');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'loginCustomerId');
  }
};
