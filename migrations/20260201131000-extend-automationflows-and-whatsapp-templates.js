'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // AutomationFlows: relacionar con catálogo y origen
    await queryInterface.addColumn('AutomationFlows', 'catalog_flow_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('AutomationFlows', 'origin', {
      type: Sequelize.ENUM('catalog', 'custom'),
      allowNull: false,
      defaultValue: 'custom',
    });

    // WhatsappTemplates: permitir placeholders sin WABA
    await queryInterface.addColumn('WhatsappTemplates', 'clinic_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex('WhatsappTemplates', ['clinic_id'], {
      name: 'idx_whatsapp_templates_clinic',
    });
    await queryInterface.changeColumn('WhatsappTemplates', 'waba_id', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('WhatsappTemplates', 'waba_id', {
      type: Sequelize.STRING,
      allowNull: false,
    });
    await queryInterface.removeIndex('WhatsappTemplates', 'idx_whatsapp_templates_clinic');
    await queryInterface.removeColumn('WhatsappTemplates', 'clinic_id');
    await queryInterface.removeColumn('AutomationFlows', 'origin');
    await queryInterface.removeColumn('AutomationFlows', 'catalog_flow_id');

    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS \"enum_AutomationFlows_origin\";');
    }
  },
};
