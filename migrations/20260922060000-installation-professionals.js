'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('Instalaciones');
    if (!columns.profesionales_permitidos) await queryInterface.addColumn('Instalaciones', 'profesionales_permitidos', {
      type: Sequelize.JSON, allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('Instalaciones', 'profesionales_permitidos');
  },
};
