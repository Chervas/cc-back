'use strict';
module.exports = {
  async up(q, S) {
    const dates = () => ({ created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } });
    await q.addColumn('AppointmentClinicalReports', 'diagnoses', { type: S.JSON, allowNull: true });
    await q.createTable('PatientClinicalMedications', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: S.STRING(36), allowNull: false, unique: true },
      patient_id: { type: S.INTEGER, allowNull: false, unique: true, references: { model: 'Pacientes', key: 'id_paciente' }, onDelete: 'RESTRICT' },
      version_number: { type: S.INTEGER.UNSIGNED, allowNull: false }, items: { type: S.JSON, allowNull: false },
      created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false }, ...dates(),
    });
    await q.createTable('PatientClinicalMedicationRevisions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      medication_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'PatientClinicalMedications', key: 'id' }, onDelete: 'RESTRICT' },
      version_number: { type: S.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: S.JSON, allowNull: false },
      command_key: { type: S.STRING(120), allowNull: false }, command_hash: { type: S.STRING(64), allowNull: false },
      clinic_id: { type: S.INTEGER, allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    await q.addIndex('PatientClinicalMedicationRevisions', ['medication_id', 'version_number'], { unique: true, name: 'clinical_medication_revision_once' });
    await q.addIndex('PatientClinicalMedicationRevisions', ['medication_id', 'command_key'], { unique: true, name: 'clinical_medication_command_once' });
    await q.createTable('AppointmentAttendanceCorrections', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      appointment_id: { type: S.INTEGER, allowNull: false, references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'RESTRICT' },
      clinic_id: { type: S.INTEGER, allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false },
      command_key: { type: S.STRING(120), allowNull: false }, command_hash: { type: S.STRING(64), allowNull: false },
      reason: { type: S.STRING(1000), allowNull: false }, snapshot: { type: S.JSON, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    await q.addIndex('AppointmentAttendanceCorrections', ['appointment_id', 'command_key'], { unique: true, name: 'clinical_attendance_command_once' });
  },
  async down() { throw Error('clinical_workspace_history_preserved: use compatible code; retain clinical revisions'); },
};
