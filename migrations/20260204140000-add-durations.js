'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Instalaciones', 'default_duracion_minutos', { type: Sequelize.INTEGER, allowNull: true, defaultValue: 30 });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('Instalaciones', 'default_duracion_minutos');
  }
};
