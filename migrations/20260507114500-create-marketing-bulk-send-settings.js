'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingBulkSendSettings', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      scope_key: {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'global',
      },
      settings: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      blocked_users: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      updated_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('MarketingBulkSendSettings', ['scope_key'], {
      unique: true,
      name: 'uq_marketing_bulk_send_settings_scope',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('MarketingBulkSendSettings');
  },
};
