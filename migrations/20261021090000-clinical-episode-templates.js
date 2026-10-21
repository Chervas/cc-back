'use strict';
module.exports = {
  async up(q, S) {
    const tables = (await q.showAllTables()).map(value => typeof value === 'string' ? value : value.tableName || value.table_name);
    if (!tables.includes('ClinicalEpisodeTemplates')) await q.createTable('ClinicalEpisodeTemplates', {
      id: { type: S.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true }, public_id: { type: S.STRING(36), allowNull: false, unique: true },
      clinic_id: { type: S.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      current_version: { type: S.INTEGER.UNSIGNED, allowNull: false }, creation_key: { type: S.STRING(64), unique: true, allowNull: false },
      creation_hash: { type: S.STRING(64), allowNull: false }, created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    });
    if (!(await q.showIndex('ClinicalEpisodeTemplates')).some(index => index.name === 'clinical_templates_clinic_page')) await q.addIndex('ClinicalEpisodeTemplates', ['clinic_id', 'id'], { name: 'clinical_templates_clinic_page' });
    if (!tables.includes('ClinicalEpisodeTemplateVersions')) await q.createTable('ClinicalEpisodeTemplateVersions', {
      id: { type: S.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true }, template_id: { type: S.BIGINT.UNSIGNED, allowNull: false,
        references: { model: 'ClinicalEpisodeTemplates', key: 'id' }, onDelete: 'RESTRICT' },
      version_number: { type: S.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: S.JSON, allowNull: false }, sha256: { type: S.STRING(64), allowNull: false },
      actor_id: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    if (!(await q.showIndex('ClinicalEpisodeTemplateVersions')).some(index => index.name === 'clinical_template_revision_once')) await q.addIndex('ClinicalEpisodeTemplateVersions', ['template_id', 'version_number'], { unique: true, name: 'clinical_template_revision_once' });
    const columns = await q.describeTable('AppointmentClinicalReports');
    if (!columns.template_snapshot) await q.addColumn('AppointmentClinicalReports', 'template_snapshot', { type: S.JSON, allowNull: true });
  },
  async down() { throw Error('clinical_template_history_preserved: roll back compatible code; retained templates and episode snapshots are not removed.'); },
};
