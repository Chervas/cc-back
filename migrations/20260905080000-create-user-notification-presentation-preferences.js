'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableName = 'UserNotificationPresentationPreferences';
    const tables = await queryInterface.showAllTables();
    const tableExists = tables.some((table) => {
      const normalized = typeof table === 'string' ? table : table?.tableName;
      return normalized === tableName;
    });
    if (!tableExists) {
      await queryInterface.createTable(tableName, {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
        },
        user_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
        },
        preference_key: {
          type: Sequelize.STRING(160),
          allowNull: false,
        },
        enabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
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
    }
    const indexes = await queryInterface.showIndex(tableName);
    if (!indexes.some((index) => index.name === 'uq_user_notification_presentation_preference')) {
      await queryInterface.addIndex(
        tableName,
        ['user_id', 'preference_key'],
        {
          name: 'uq_user_notification_presentation_preference',
          unique: true,
        },
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'UserNotificationPresentationPreferences',
      'uq_user_notification_presentation_preference',
    );
    await queryInterface.dropTable('UserNotificationPresentationPreferences');
  },
};
