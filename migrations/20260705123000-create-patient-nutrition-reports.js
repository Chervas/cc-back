'use strict';

function tableNamesFromList(tables) {
  return tables.map((table) => (typeof table === 'string' ? table : table.tableName || table.table_name));
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const tableNames = tableNamesFromList(tables);
    if (tableNames.includes('PatientNutritionReports')) {
      return;
    }

    await queryInterface.createTable('PatientNutritionReports', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      public_id: {
        type: Sequelize.STRING(80),
        allowNull: false,
        unique: true,
      },
      measurement_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'PatientNutritionMeasurements', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      appointment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'CitasPacientes', key: 'id_cita' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      treatment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      report_type: {
        type: Sequelize.STRING(60),
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(40),
        allowNull: false,
        defaultValue: 'active',
      },
      formula_version: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      snapshot_json: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: {},
      },
      snapshot_html: {
        type: Sequelize.TEXT('medium'),
        allowNull: true,
      },
      snapshot_hash: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      pdf_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      storage_strategy: {
        type: Sequelize.STRING(80),
        allowNull: false,
        defaultValue: 'json_snapshot_printable_on_demand',
      },
      generated_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      generated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
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

    await queryInterface.addIndex('PatientNutritionReports', {
      fields: ['measurement_id', 'status'],
      name: 'idx_patient_nutrition_reports_measurement_status',
    });
    await queryInterface.addIndex('PatientNutritionReports', {
      fields: ['patient_id', 'generated_at'],
      name: 'idx_patient_nutrition_reports_patient_generated',
    });
    await queryInterface.addIndex('PatientNutritionReports', {
      fields: ['clinic_id', 'generated_at'],
      name: 'idx_patient_nutrition_reports_clinic_generated',
    });
    await queryInterface.addIndex('PatientNutritionReports', {
      fields: ['snapshot_hash'],
      name: 'idx_patient_nutrition_reports_snapshot_hash',
    });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const tableNames = tableNamesFromList(tables);
    if (!tableNames.includes('PatientNutritionReports')) {
      return;
    }

    await queryInterface.removeIndex('PatientNutritionReports', 'idx_patient_nutrition_reports_snapshot_hash').catch(() => {});
    await queryInterface.removeIndex('PatientNutritionReports', 'idx_patient_nutrition_reports_clinic_generated').catch(() => {});
    await queryInterface.removeIndex('PatientNutritionReports', 'idx_patient_nutrition_reports_patient_generated').catch(() => {});
    await queryInterface.removeIndex('PatientNutritionReports', 'idx_patient_nutrition_reports_measurement_status').catch(() => {});
    await queryInterface.dropTable('PatientNutritionReports');
  },
};
