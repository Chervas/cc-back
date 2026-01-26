'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AutomationFlows', 'descripcion', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('AutomationFlows', 'disciplina_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('AutomationFlows', 'tratamiento_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('AutomationFlows', 'estado', {
      type: Sequelize.ENUM('borrador', 'activo', 'pausado', 'archivado'),
      allowNull: false,
      defaultValue: 'borrador',
    });
    await queryInterface.addColumn('AutomationFlows', 'pasos', {
      type: Sequelize.JSON,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('AutomationFlows', 'pasos');
    await queryInterface.removeColumn('AutomationFlows', 'estado');
    await queryInterface.removeColumn('AutomationFlows', 'tratamiento_id');
    await queryInterface.removeColumn('AutomationFlows', 'disciplina_id');
    await queryInterface.removeColumn('AutomationFlows', 'descripcion');
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AutomationFlows_estado";');
    }
  },
};
