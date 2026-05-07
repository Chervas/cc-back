'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PatientCustomFields', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      field_key: { type: Sequelize.STRING(120), allowNull: false },
      label: { type: Sequelize.STRING(255), allowNull: true },
      value: { type: Sequelize.TEXT, allowNull: true },
      value_type: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'text' },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'import' },
      source_column: { type: Sequelize.STRING(255), allowNull: true },
      last_imported_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('PatientCustomFields', {
      name: 'uniq_patient_custom_fields_scope_key',
      fields: ['paciente_id', 'clinica_id', 'field_key'],
      unique: true,
    });
    await queryInterface.addIndex('PatientCustomFields', {
      name: 'idx_patient_custom_fields_clinic_key',
      fields: ['clinica_id', 'field_key'],
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('PatientCustomFields', 'idx_patient_custom_fields_clinic_key');
    await queryInterface.removeIndex('PatientCustomFields', 'uniq_patient_custom_fields_scope_key');
    await queryInterface.dropTable('PatientCustomFields');
  },
};
