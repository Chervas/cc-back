'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Clinicas', 'datos_fiscales_clinica', {
      type: Sequelize.JSON,
      allowNull: true
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Clinicas', 'datos_fiscales_clinica');
  }
};
