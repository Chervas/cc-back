'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('UsuarioClinica', 'datos_fiscales_clinica', {
      type: Sequelize.JSON,
      allowNull: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('UsuarioClinica', 'datos_fiscales_clinica');
  }
};
