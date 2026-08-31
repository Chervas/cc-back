'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PatientConsentExternalAttestations', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      public_id: {
        type: Sequelize.STRING(80),
        allowNull: false,
        unique: true,
      },
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
      tratamiento_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      purpose: {
        type: Sequelize.STRING(80),
        allowNull: false,
        defaultValue: 'clinical',
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      note: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      source: {
        type: Sequelize.STRING(80),
        allowNull: false,
        defaultValue: 'external_written',
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'active',
      },
      attested_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      attested_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      revoked_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      revoked_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    await queryInterface.addIndex('PatientConsentExternalAttestations', ['paciente_id', 'clinica_id', 'status'], {
      name: 'idx_patient_consent_external_patient_clinic_status',
    });
    await queryInterface.addIndex('PatientConsentExternalAttestations', ['clinica_id', 'attested_at'], {
      name: 'idx_patient_consent_external_clinic_attested',
    });
    await queryInterface.addIndex('PatientConsentExternalAttestations', ['tratamiento_id'], {
      name: 'idx_patient_consent_external_treatment',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PatientConsentExternalAttestations');
  },
};
