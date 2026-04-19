'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('Instalaciones', 'tipo', {
      type: Sequelize.ENUM('box', 'quirofano', 'sala', 'consulta', 'laboratorio', 'sala_pruebas', 'sala_polivalente', 'otro'),
      allowNull: false,
      defaultValue: 'box',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('Instalaciones', 'tipo', {
      type: Sequelize.ENUM('box', 'quirofano', 'sala_pruebas', 'sala_polivalente', 'otro'),
      allowNull: false,
      defaultValue: 'box',
    });
  },
};
