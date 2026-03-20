'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('AdminCampaignPlaybooks');
    if (table.discipline && !table.area_medica) {
      await queryInterface.renameColumn('AdminCampaignPlaybooks', 'discipline', 'area_medica');
    }
  },

  async down(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('AdminCampaignPlaybooks');
    if (table.area_medica && !table.discipline) {
      await queryInterface.renameColumn('AdminCampaignPlaybooks', 'area_medica', 'discipline');
    }
  }
};
