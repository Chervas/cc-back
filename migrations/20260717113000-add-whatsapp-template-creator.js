'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await queryInterface.describeTable('WhatsappTemplates');
    if (!definition.created_by_user_id) {
      await queryInterface.addColumn('WhatsappTemplates', 'created_by_user_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }

    const indexes = await queryInterface.showIndex('WhatsappTemplates');
    if (!indexes.some((index) => index.name === 'idx_whatsapp_templates_creator_active')) {
      await queryInterface.addIndex(
        'WhatsappTemplates',
        ['created_by_user_id', 'is_active'],
        { name: 'idx_whatsapp_templates_creator_active' }
      );
    }

    // No se atribuyen filas historicas a una persona por inferencia. La cuenta
    // que conecto el WABA no demuestra quien creo cada plantilla.
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('WhatsappTemplates');
    if (indexes.some((index) => index.name === 'idx_whatsapp_templates_creator_active')) {
      await queryInterface.removeIndex('WhatsappTemplates', 'idx_whatsapp_templates_creator_active');
    }
    const definition = await queryInterface.describeTable('WhatsappTemplates');
    if (definition.created_by_user_id) {
      await queryInterface.removeColumn('WhatsappTemplates', 'created_by_user_id');
    }
  },
};
