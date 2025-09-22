'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addIndex('WebScQueryDaily', ['clinica_id', 'date'], {
      name: 'idx_webscquerydaily_clinic_date'
    });
    await queryInterface.addIndex('WebScQueryDaily', ['clinica_id', 'query_hash', 'date'], {
      name: 'idx_webscquerydaily_clinic_query_date'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('WebScQueryDaily', 'idx_webscquerydaily_clinic_query_date');
    await queryInterface.removeIndex('WebScQueryDaily', 'idx_webscquerydaily_clinic_date');
  }
};
