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
    if (await hasTable(queryInterface, 'WhatsappAccountComplianceIncidents')) return;

    await queryInterface.createTable('WhatsappAccountComplianceIncidents', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      dedupe_key: { type: Sequelize.STRING(64), allowNull: false, unique: true },
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
      asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicMetaAssets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      waba_id: { type: Sequelize.STRING(255), allowNull: true },
      phone_number_id: { type: Sequelize.STRING(255), allowNull: true },
      phone_number: { type: Sequelize.STRING(64), allowNull: true },
      webhook_field: { type: Sequelize.STRING(96), allowNull: false, defaultValue: 'account_update' },
      provider_event: { type: Sequelize.STRING(96), allowNull: false },
      severity: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'warning' },
      operational_status: { type: Sequelize.STRING(64), allowNull: false },
      violation_type: { type: Sequelize.STRING(96), allowNull: true },
      ban_state: { type: Sequelize.STRING(64), allowNull: true },
      ban_date: { type: Sequelize.DATE, allowNull: true },
      restriction_info: { type: Sequelize.JSON, allowNull: true },
      remediation: { type: Sequelize.TEXT, allowNull: true },
      raw_payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      status: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'open' },
      appealable: { type: Sequelize.BOOLEAN, allowNull: true },
      client_requested_at: { type: Sequelize.DATE, allowNull: true },
      client_requested_by: { type: Sequelize.INTEGER, allowNull: true },
      appeal_draft: { type: Sequelize.TEXT, allowNull: true },
      appeal_context: { type: Sequelize.JSON, allowNull: true },
      appeal_prepared_at: { type: Sequelize.DATE, allowNull: true },
      appeal_prepared_by: { type: Sequelize.INTEGER, allowNull: true },
      appeal_submitted_at: { type: Sequelize.DATE, allowNull: true },
      appeal_submitted_by: { type: Sequelize.INTEGER, allowNull: true },
      provider_resolution: { type: Sequelize.STRING(96), allowNull: true },
      resolved_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('WhatsappAccountComplianceIncidents', ['waba_id', 'status'], {
      name: 'idx_whatsapp_compliance_waba_status',
    });
    await queryInterface.addIndex('WhatsappAccountComplianceIncidents', ['clinic_id', 'occurred_at'], {
      name: 'idx_whatsapp_compliance_clinic_date',
    });
    await queryInterface.addIndex('WhatsappAccountComplianceIncidents', ['operational_status', 'occurred_at'], {
      name: 'idx_whatsapp_compliance_operational_date',
    });
  },

  async down(queryInterface) {
    if (await hasTable(queryInterface, 'WhatsappAccountComplianceIncidents')) {
      await queryInterface.dropTable('WhatsappAccountComplianceIncidents');
    }
  },
};
