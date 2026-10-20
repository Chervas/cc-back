'use strict';

// Additive clinical foundation. Existing report identities, text, appointment
// ownership and revisions remain untouched. Historical rows are adapted only
// when read; no migration infers or duplicates a clinical narrative.
module.exports = {
  async up(queryInterface, S) {
    const table = 'AppointmentClinicalReports';
    let columns = await queryInterface.describeTable(table);
    if (!columns.appointment_id) throw Error('clinical_reports_prerequisite_missing');
    const additions = {
      title: { type: S.STRING(255), allowNull: true },
      occurred_at: { type: S.DATE, allowNull: true },
      template_key: { type: S.STRING(40), allowNull: true },
      rich_document: { type: S.JSON, allowNull: true },
      material_refs: { type: S.JSON, allowNull: true },
      creation_key: { type: S.STRING(64), allowNull: true },
      creation_payload_hash: { type: S.STRING(64), allowNull: true },
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns[name]) await queryInterface.addColumn(table, name, definition);
    }
    if (!columns.appointment_id.allowNull) await queryInterface.changeColumn(table, 'appointment_id', { type: S.INTEGER, allowNull: true });
    const index = async (tableName, fields, name, unique = false) => {
      const indexes = await queryInterface.showIndex(tableName);
      if (!indexes.some(item => item.name === name)) await queryInterface.addIndex(tableName, fields, { name, unique });
    };
    await index(table, ['creation_key'], 'clinical_episodes_creation_uq', true);
    await index(table, ['clinic_id', 'patient_id', 'occurred_at', 'id'], 'clinical_episodes_patient_date_idx');
    columns = await queryInterface.describeTable('AppointmentClinicalReportRevisions');
    for (const name of ['mutation_key', 'request_hash']) {
      if (!columns[name]) await queryInterface.addColumn('AppointmentClinicalReportRevisions', name, { type: S.STRING(64), allowNull: true });
    }
    await index('AppointmentClinicalReportRevisions', ['report_id', 'mutation_key'], 'clinical_episode_revision_mutation_uq', true);
    const tables = (await queryInterface.showAllTables()).map(value => typeof value === 'string' ? value : value.tableName || value.table_name);
    if (!tables.includes('ClinicalEpisodeAppointments')) {
      await queryInterface.createTable('ClinicalEpisodeAppointments', {
        appointment_id: { type: S.INTEGER, primaryKey: true, allowNull: false,
          references: { model: 'CitasPacientes', key: 'id_cita' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
        report_id: { type: S.BIGINT.UNSIGNED, allowNull: false,
          references: { model: table, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
        clinic_id: { type: S.INTEGER, allowNull: false,
          references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
        patient_id: { type: S.INTEGER, allowNull: false,
          references: { model: 'Pacientes', key: 'id_paciente' }, onDelete: 'RESTRICT' },
        created_by: { type: S.INTEGER, allowNull: true },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.fn('NOW') },
      });
    }
    await index('ClinicalEpisodeAppointments', ['report_id', 'appointment_id'], 'clinical_episode_appointments_report_idx');
  },
  async down() {
    throw Error('clinical_episode_history_preserved: restore by a reviewed forward migration, never drop clinical history');
  },
};
