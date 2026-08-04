'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('EconomicBudgetSignatureRequests', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'CASCADE',
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      budget_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      request_type: {
        type: Sequelize.ENUM('accept_full', 'accept_partial'),
        allowNull: false,
        defaultValue: 'accept_full',
      },
      status: {
        type: Sequelize.ENUM('pending', 'sent', 'viewed', 'signed', 'cancelled', 'expired', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      channel: {
        type: Sequelize.ENUM('whatsapp', 'email', 'custom_email', 'tablet'),
        allowNull: false,
      },
      recipient: { type: Sequelize.STRING(190), allowNull: true },
      selected_payment_mode: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'patient_choice' },
      selected_financing_months: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      collection_method: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'pending' },
      signature_channel: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'mobile' },
      bank_data_policy: {
        type: Sequelize.ENUM('defer', 'request_now'),
        allowNull: false,
        defaultValue: 'defer',
      },
      bank_data_status: {
        type: Sequelize.ENUM('not_required', 'pending', 'complete'),
        allowNull: false,
        defaultValue: 'not_required',
      },
      accepted_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      accepted_line_keys: { type: Sequelize.JSON, allowNull: true },
      snapshot_json: { type: Sequelize.JSON, allowNull: false },
      snapshot_hash: { type: Sequelize.STRING(64), allowNull: false },
      public_url: { type: Sequelize.TEXT, allowNull: true },
      delivery_result: { type: Sequelize.JSON, allowNull: true },
      signed_payload: { type: Sequelize.JSON, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      sent_at: { type: Sequelize.DATE, allowNull: true },
      viewed_at: { type: Sequelize.DATE, allowNull: true },
      signed_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await queryInterface.addIndex('EconomicBudgetSignatureRequests', ['budget_id', 'status'], {
      name: 'economic_budget_signature_budget_status_idx',
    });
    await queryInterface.addIndex('EconomicBudgetSignatureRequests', ['clinic_id', 'status', 'expires_at'], {
      name: 'economic_budget_signature_clinic_queue_idx',
    });
    await queryInterface.addIndex('EconomicBudgetSignatureRequests', ['patient_id', 'status'], {
      name: 'economic_budget_signature_patient_status_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('EconomicBudgetSignatureRequests');
  },
};
