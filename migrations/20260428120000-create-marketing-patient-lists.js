'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingPatientLists', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      name: { type: Sequelize.STRING(255), allowNull: false },
      objective_id: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'reactivate_patients' },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'clinical_inactive' },
      status: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'draft' },
      scope_type: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'clinic' },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      clinic_ids: { type: Sequelize.JSON, allowNull: true },
      treatment: { type: Sequelize.STRING(255), allowNull: true },
      condition_summary: { type: Sequelize.TEXT, allowNull: true },
      exclusion_summary: { type: Sequelize.TEXT, allowNull: true },
      criteria: { type: Sequelize.JSON, allowNull: true },
      action_mode: { type: Sequelize.STRING(64), allowNull: true },
      channel: { type: Sequelize.STRING(32), allowNull: true },
      template_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'MessageTemplates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      template_snapshot: { type: Sequelize.JSON, allowNull: true },
      counters: { type: Sequelize.JSON, allowNull: false },
      metrics: { type: Sequelize.JSON, allowNull: false },
      automation: { type: Sequelize.JSON, allowNull: true },
      safety_gates: { type: Sequelize.JSON, allowNull: false },
      custom_fields_schema: { type: Sequelize.JSON, allowNull: true },
      prepared_at: { type: Sequelize.DATE, allowNull: true },
      last_sent_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('MarketingPatientListItems', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      list_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'MarketingPatientLists', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      phone: { type: Sequelize.STRING(64), allowNull: true },
      email: { type: Sequelize.STRING(255), allowNull: true },
      treatment: { type: Sequelize.STRING(255), allowNull: true },
      last_visit_at: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'ready' },
      reason: { type: Sequelize.STRING(512), allowNull: true },
      exclusion_reason: { type: Sequelize.STRING(64), allowNull: true },
      selected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      custom_fields: { type: Sequelize.JSON, allowNull: true },
      missing_variables: { type: Sequelize.JSON, allowNull: true },
      appointment_at: { type: Sequelize.DATE, allowNull: true },
      treatment_completed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('MarketingPatientContactEvents', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      list_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'MarketingPatientLists', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      item_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'MarketingPatientListItems', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      event_type: { type: Sequelize.STRING(64), allowNull: false },
      channel: { type: Sequelize.STRING(32), allowNull: true },
      payload: { type: Sequelize.JSON, allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('MarketingPatientLists', { name: 'idx_marketing_patient_lists_scope', fields: ['scope_type', 'clinica_id', 'grupo_clinica_id'] });
    await queryInterface.addIndex('MarketingPatientLists', { name: 'idx_marketing_patient_lists_status', fields: ['status'] });
    await queryInterface.addIndex('MarketingPatientLists', { name: 'idx_marketing_patient_lists_objective', fields: ['objective_id'] });
    await queryInterface.addIndex('MarketingPatientListItems', { name: 'idx_marketing_patient_list_items_list', fields: ['list_id'] });
    await queryInterface.addIndex('MarketingPatientListItems', { name: 'idx_marketing_patient_list_items_patient', fields: ['paciente_id'] });
    await queryInterface.addIndex('MarketingPatientListItems', { name: 'idx_marketing_patient_list_items_status', fields: ['status'] });
    await queryInterface.addIndex('MarketingPatientContactEvents', { name: 'idx_marketing_patient_contact_events_list', fields: ['list_id', 'created_at'] });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MarketingPatientContactEvents', 'idx_marketing_patient_contact_events_list');
    await queryInterface.removeIndex('MarketingPatientListItems', 'idx_marketing_patient_list_items_status');
    await queryInterface.removeIndex('MarketingPatientListItems', 'idx_marketing_patient_list_items_patient');
    await queryInterface.removeIndex('MarketingPatientListItems', 'idx_marketing_patient_list_items_list');
    await queryInterface.removeIndex('MarketingPatientLists', 'idx_marketing_patient_lists_objective');
    await queryInterface.removeIndex('MarketingPatientLists', 'idx_marketing_patient_lists_status');
    await queryInterface.removeIndex('MarketingPatientLists', 'idx_marketing_patient_lists_scope');
    await queryInterface.dropTable('MarketingPatientContactEvents');
    await queryInterface.dropTable('MarketingPatientListItems');
    await queryInterface.dropTable('MarketingPatientLists');
  }
};
