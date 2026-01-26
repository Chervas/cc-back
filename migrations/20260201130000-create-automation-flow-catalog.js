'use strict';

/**
 * Catálogo de automatizaciones predefinidas y su relación con disciplinas.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AutomationFlowCatalog', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(100), allowNull: false, unique: true },
      display_name: { type: Sequelize.STRING(150), allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      trigger_type: { type: Sequelize.STRING(50), allowNull: false },
      steps: { type: Sequelize.JSON, allowNull: false },
      is_generic: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('AutomationFlowCatalogDisciplines', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      flow_catalog_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'AutomationFlowCatalog', key: 'id' },
        onDelete: 'CASCADE',
      },
      disciplina_code: { type: Sequelize.STRING(50), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('AutomationFlowCatalogDisciplines', {
      fields: ['flow_catalog_id', 'disciplina_code'],
      type: 'unique',
      name: 'uniq_flow_catalog_disciplina',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('AutomationFlowCatalogDisciplines');
    await queryInterface.dropTable('AutomationFlowCatalog');

    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS \"enum_AutomationFlowCatalog_trigger_type\";');
    }
  },
};
