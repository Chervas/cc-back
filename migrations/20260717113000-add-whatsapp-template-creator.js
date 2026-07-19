'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('WhatsappTemplates', 'created_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Usuarios', key: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });

    await queryInterface.addIndex(
      'WhatsappTemplates',
      ['created_by_user_id', 'is_active'],
      { name: 'idx_whatsapp_templates_creator_active' }
    );

    // No se atribuyen filas historicas a una persona por inferencia. La cuenta
    // que conecto el WABA no demuestra quien creo cada plantilla.
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('WhatsappTemplates', 'idx_whatsapp_templates_creator_active');
    await queryInterface.removeColumn('WhatsappTemplates', 'created_by_user_id');
  },
};
