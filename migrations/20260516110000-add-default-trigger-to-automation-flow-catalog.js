'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('AutomationFlowCatalog');

    if (!table.is_default_for_trigger) {
      await queryInterface.addColumn('AutomationFlowCatalog', 'is_default_for_trigger', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'is_active',
      });
    }

    const indexes = await queryInterface.showIndex('AutomationFlowCatalog').catch(() => []);
    if (!indexes.some((index) => index.name === 'idx_automation_flow_catalog_default_trigger')) {
      await queryInterface.addIndex('AutomationFlowCatalog', ['trigger_type', 'is_default_for_trigger'], {
        name: 'idx_automation_flow_catalog_default_trigger',
      });
    }

    await queryInterface.sequelize.query(`
      UPDATE AutomationFlowCatalog
      SET is_default_for_trigger = CASE
        WHEN name IN (
          'envio_de_datos_de_la_cita_tras_agendar',
          'envio_de_datos_de_la_cita_tras_reprogramar'
        ) AND is_active = 1 THEN 1
        ELSE 0
      END
    `);
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('AutomationFlowCatalog').catch(() => []);
    if (indexes.some((index) => index.name === 'idx_automation_flow_catalog_default_trigger')) {
      await queryInterface.removeIndex('AutomationFlowCatalog', 'idx_automation_flow_catalog_default_trigger');
    }

    const table = await queryInterface.describeTable('AutomationFlowCatalog');
    if (table.is_default_for_trigger) {
      await queryInterface.removeColumn('AutomationFlowCatalog', 'is_default_for_trigger');
    }
  },
};
