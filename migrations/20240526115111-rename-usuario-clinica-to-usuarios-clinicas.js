'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameTable('UsuarioClinica', 'UsuariosClinicas');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.renameTable('UsuariosClinicas', 'UsuarioClinica');
  }
};
