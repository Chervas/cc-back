'use strict';

module.exports = {
  async up(queryInterface) {
    try {
      await queryInterface.removeConstraint('ClinicGoogleAdsAccounts', 'uniq_google_connection_customer');
    } catch (error) {
      // ignore if missing
    }

    try {
      await queryInterface.addConstraint('ClinicGoogleAdsAccounts', {
        fields: ['clinicaId', 'customerId'],
        type: 'unique',
        name: 'uniq_clinic_google_ads_customer'
      });
    } catch (error) {
      // ignore if already exists
    }
  },

  async down(queryInterface) {
    try {
      await queryInterface.removeConstraint('ClinicGoogleAdsAccounts', 'uniq_clinic_google_ads_customer');
    } catch (error) {
      // ignore if missing
    }

    try {
      await queryInterface.addConstraint('ClinicGoogleAdsAccounts', {
        fields: ['googleConnectionId', 'customerId'],
        type: 'unique',
        name: 'uniq_google_connection_customer'
      });
    } catch (error) {
      // ignore if already exists
    }
  }
};
