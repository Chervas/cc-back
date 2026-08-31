'use strict';

function tableNameOf(table) {
  return typeof table === 'string'
    ? table
    : (table?.tableName || table?.table_name || table?.name || '');
}

async function hasTable(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some((table) => tableNameOf(table).toLowerCase() === tableName.toLowerCase());
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await hasTable(queryInterface, 'WhatsappAccountHealthEvents')) return;

    await queryInterface.createTable('WhatsappAccountHealthEvents', {
      id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
      dedupe_key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicMetaAssets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      waba_id: { type: Sequelize.STRING(255), allowNull: true },
      phone_number_id: { type: Sequelize.STRING(255), allowNull: true },
      phone_number: { type: Sequelize.STRING(64), allowNull: true },
      event_type: { type: Sequelize.STRING(64), allowNull: false },
      source: { type: Sequelize.STRING(96), allowNull: false },
      previous_state: { type: Sequelize.STRING(32), allowNull: true },
      state: { type: Sequelize.STRING(32), allowNull: false },
      severity: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'info' },
      can_send: { type: Sequelize.BOOLEAN, allowNull: true },
      reason_code: { type: Sequelize.STRING(128), allowNull: true },
      provider_status: { type: Sequelize.STRING(64), allowNull: true },
      provider_error_code: { type: Sequelize.STRING(32), allowNull: true },
      details: { type: Sequelize.JSON, allowNull: true },
      observed_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('WhatsappAccountHealthEvents', ['asset_id', 'observed_at'], {
      name: 'idx_whatsapp_health_asset_date',
    });
    await queryInterface.addIndex('WhatsappAccountHealthEvents', ['state', 'observed_at'], {
      name: 'idx_whatsapp_health_state_date',
    });
    await queryInterface.addIndex('WhatsappAccountHealthEvents', ['phone_number_id', 'observed_at'], {
      name: 'idx_whatsapp_health_phone_date',
    });
  },

  async down(queryInterface) {
    if (await hasTable(queryInterface, 'WhatsappAccountHealthEvents')) {
      await queryInterface.dropTable('WhatsappAccountHealthEvents');
    }
  },
};
