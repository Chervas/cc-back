'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameTable('UsuariosClinicas', 'UsuarioClinica');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.renameTable('UsuarioClinica', 'UsuariosClinicas');
  }
};
