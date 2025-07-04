'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameTable('ClinicaServicios', 'ClinicaServicio');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.renameTable('ClinicaServicio', 'ClinicaServicios');
  }
};
