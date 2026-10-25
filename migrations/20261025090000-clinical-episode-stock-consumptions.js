'use strict';

// Selected additive migration only. No runtime DDL and no historical backfill.
module.exports = {
  async up(q, S) {
    const table = 'ClinicalEpisodeStockConsumptions';
    const tables = (await q.showAllTables()).map(item => typeof item === 'string' ? item : item.tableName || item.table_name);
    if (!tables.includes(table)) await q.createTable(table, {
      id: { type: S.STRING(36), primaryKey: true, allowNull: false },
      clinic_id: { type: S.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      patient_id: { type: S.INTEGER, allowNull: false, references: { model: 'Pacientes', key: 'id_paciente' }, onDelete: 'RESTRICT' },
      report_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'AppointmentClinicalReports', key: 'id' }, onDelete: 'RESTRICT' },
      product_id: { type: S.STRING(36), allowNull: false, references: { model: 'ClinicStockProducts', key: 'id' }, onDelete: 'RESTRICT' },
      movement_id: { type: S.STRING(36), allowNull: false, references: { model: 'ClinicStockMovements', key: 'id' }, onDelete: 'RESTRICT' },
      product_name: { type: S.STRING(160), allowNull: false }, unit: { type: S.STRING(40), allowNull: false },
      quantity: { type: S.DECIMAL(14, 3), allowNull: false },
      episode_version: { type: S.INTEGER.UNSIGNED, allowNull: false },
      reason: { type: S.STRING(500), allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    });
    const indexes = await q.showIndex(table);
    if (!indexes.some(index => index.name === 'clinical_consumption_movement_once')) await q.addIndex(table, ['movement_id'], { unique: true, name: 'clinical_consumption_movement_once' });
    if (!indexes.some(index => index.name === 'clinical_consumption_episode')) await q.addIndex(table, ['clinic_id', 'patient_id', 'report_id', 'episode_version', 'id'], { name: 'clinical_consumption_episode' });
  },
  async down() { throw Error('clinical_consumption_history_preserved_rollback_code_only'); },
};
