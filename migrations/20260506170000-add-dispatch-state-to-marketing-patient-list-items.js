'use strict';

async function addColumnIfMissing(queryInterface, table, column, definition) {
  const tableDefinition = await queryInterface.describeTable(table);
  if (!tableDefinition[column]) {
    await queryInterface.addColumn(table, column, definition);
  }
}

async function addIndexIfMissing(queryInterface, table, fields, options) {
  const indexes = await queryInterface.showIndex(table);
  const name = options?.name;
  if (name && indexes.some((index) => index.name === name)) {
    return;
  }
  await queryInterface.addIndex(table, fields, options);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'dispatch_status', {
      type: Sequelize.STRING(32),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'provider_message_id', {
      type: Sequelize.STRING(255),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'app_message_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'conversation_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'send_batch_index', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'delivered_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'read_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'replied_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'failed_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'opt_out_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'last_error_code', {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'MarketingPatientListItems', 'last_error_message', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await addIndexIfMissing(queryInterface, 'MarketingPatientListItems', ['list_id', 'dispatch_status'], {
      name: 'idx_marketing_list_items_dispatch_status',
    });
    await addIndexIfMissing(queryInterface, 'MarketingPatientListItems', ['provider_message_id'], {
      name: 'idx_marketing_list_items_provider_message_id',
    });
    await addIndexIfMissing(queryInterface, 'MarketingPatientListItems', ['app_message_id'], {
      name: 'idx_marketing_list_items_app_message_id',
    });
  },

  async down(queryInterface) {
    const tableDefinition = await queryInterface.describeTable('MarketingPatientListItems');
    const columns = [
      'dispatch_status',
      'provider_message_id',
      'app_message_id',
      'conversation_id',
      'send_batch_index',
      'sent_at',
      'delivered_at',
      'read_at',
      'replied_at',
      'failed_at',
      'opt_out_at',
      'last_error_code',
      'last_error_message',
    ];

    for (const column of columns.reverse()) {
      if (tableDefinition[column]) {
        await queryInterface.removeColumn('MarketingPatientListItems', column);
      }
    }
  },
};
