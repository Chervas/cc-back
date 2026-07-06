'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tratamientos = await queryInterface.describeTable('Tratamientos');
    if (!tratamientos.clinical_config) {
      await queryInterface.addColumn('Tratamientos', 'clinical_config', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }

    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((table) => (typeof table === 'string' ? table : table.tableName || table.table_name));
    if (!tableNames.includes('PatientNutritionMeasurements')) {
      await queryInterface.createTable('PatientNutritionMeasurements', {
        id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
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
        professional_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
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
        profile_code: {
          type: Sequelize.STRING(40),
          allowNull: false,
          defaultValue: 'quick',
        },
        measured_at: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        raw_values_json: {
          type: Sequelize.JSON,
          allowNull: false,
          defaultValue: {},
        },
        calculated_values_json: {
          type: Sequelize.JSON,
          allowNull: true,
        },
        formula_version: {
          type: Sequelize.STRING(80),
          allowNull: false,
          defaultValue: 'nutrition-basic-v1',
        },
        quality_flags_json: {
          type: Sequelize.JSON,
          allowNull: true,
        },
        notes: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        created_by: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        updated_by: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
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

      await queryInterface.addIndex('PatientNutritionMeasurements', {
        fields: ['patient_id', 'measured_at'],
        name: 'idx_patient_nutrition_measurements_patient_date',
      });
      await queryInterface.addIndex('PatientNutritionMeasurements', {
        fields: ['clinic_id', 'measured_at'],
        name: 'idx_patient_nutrition_measurements_clinic_date',
      });
      await queryInterface.addIndex('PatientNutritionMeasurements', {
        fields: ['appointment_id'],
        name: 'idx_patient_nutrition_measurements_appointment',
      });
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((table) => (typeof table === 'string' ? table : table.tableName || table.table_name));
    if (tableNames.includes('PatientNutritionMeasurements')) {
      await queryInterface.removeIndex('PatientNutritionMeasurements', 'idx_patient_nutrition_measurements_appointment').catch(() => {});
      await queryInterface.removeIndex('PatientNutritionMeasurements', 'idx_patient_nutrition_measurements_clinic_date').catch(() => {});
      await queryInterface.removeIndex('PatientNutritionMeasurements', 'idx_patient_nutrition_measurements_patient_date').catch(() => {});
      await queryInterface.dropTable('PatientNutritionMeasurements');
    }

    const tratamientos = await queryInterface.describeTable('Tratamientos');
    if (tratamientos.clinical_config) {
      await queryInterface.removeColumn('Tratamientos', 'clinical_config');
    }
  },
};
