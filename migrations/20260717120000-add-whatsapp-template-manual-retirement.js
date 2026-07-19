'use strict';

const TABLE = 'WhatsappTemplates';

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await queryInterface.describeTable(TABLE);

    if (!definition.retired_at) {
      await queryInterface.addColumn(TABLE, 'retired_at', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Tombstone local explícito: retirada manual, independiente del estado remoto de Meta',
      });
    }

    if (!definition.retired_by_user_id) {
      await queryInterface.addColumn(TABLE, 'retired_by_user_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Usuario que retiró manualmente la plantilla; puede quedar NULL sin perder el tombstone',
      });
    }
  },

  async down(queryInterface) {
    const definition = await queryInterface.describeTable(TABLE);
    if (definition.retired_by_user_id) {
      await queryInterface.removeColumn(TABLE, 'retired_by_user_id');
    }
    if (definition.retired_at) {
      await queryInterface.removeColumn(TABLE, 'retired_at');
    }
  },
};
