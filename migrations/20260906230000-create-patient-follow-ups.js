'use strict';

// Additive only: no scheduler, import, notification or existing appointment mutation.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('PatientFollowUps', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      patient_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Pacientes', key: 'id_paciente' }, onDelete: 'RESTRICT' },
      treatment_id: { type: Sequelize.INTEGER, allowNull: true },
      operational_reason: { type: Sequelize.STRING(500), allowNull: false },
      clinical_notes: { type: Sequelize.TEXT, allowNull: true },
      clinical_target_date: { type: Sequelize.DATEONLY, allowNull: true },
      contact_due_date: { type: Sequelize.DATEONLY, allowNull: true },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
      // Deleted cancelled appointments must not delete follow-up history. Source
      // identity and revision snapshots retain the original appointment IDs.
      linked_appointment_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'SET NULL' },
      source_appointment_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'SET NULL' },
      source_report_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      source_kind: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'manual' },
      source_namespace: { type: Sequelize.STRING(120), allowNull: true },
      source_reference: { type: Sequelize.STRING(200), allowNull: true },
      source_key: { type: Sequelize.STRING(64), allowNull: true, unique: true },
      source_date: { type: Sequelize.DATEONLY, allowNull: true },
      source_date_semantics: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'unknown' },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('PatientFollowUps', ['clinic_id', 'patient_id', 'id'], { name: 'pfu_clinic_patient_page' });
    await queryInterface.addIndex('PatientFollowUps', ['clinic_id', 'status', 'contact_due_date', 'id'], { name: 'pfu_clinic_due' });
    await queryInterface.addIndex('PatientFollowUps', ['linked_appointment_id'], { name: 'pfu_linked_appointment' });
    await queryInterface.createTable('PatientFollowUpRevisions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      follow_up_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, references: { model: 'PatientFollowUps', key: 'id' }, onDelete: 'RESTRICT' },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      actor_id: { type: Sequelize.INTEGER, allowNull: true },
      change_type: { type: Sequelize.STRING(24), allowNull: false },
      snapshot: { type: Sequelize.JSON, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('PatientFollowUpRevisions', ['follow_up_id', 'version_number'], { name: 'pfur_version_unique', unique: true });
  },

  async down(queryInterface) {
    // Clinical history must not be silently deleted by an ordinary rollback.
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS count FROM PatientFollowUps');
    if (Number(rows[0].count) > 0) throw new Error('PatientFollowUps contiene historia: exporta y aprueba un rollback de datos antes de retirar las tablas.');
    await queryInterface.dropTable('PatientFollowUpRevisions');
    await queryInterface.dropTable('PatientFollowUps');
  },
};
