'use strict';
module.exports = {
  async up(q, S) {
    const tables = (await q.showAllTables()).map(value => typeof value === 'string' ? value : value.tableName || value.table_name);
    const ref = (model, key, type = S.INTEGER) => ({ type, allowNull: false, references: { model, key }, onDelete: 'RESTRICT' });
    if (!tables.includes('ClinicalTreatmentTemplateDefaults')) await q.createTable('ClinicalTreatmentTemplateDefaults', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: { type: S.STRING(36), allowNull: false, unique: true },
      clinic_id: ref('Clinicas', 'id_clinica'), treatment_id: ref('Tratamientos', 'id_tratamiento'),
      version_number: { type: S.INTEGER.UNSIGNED, allowNull: false }, enabled: { type: S.BOOLEAN, allowNull: false },
      template_ref: { type: S.JSON, allowNull: true }, treatment_title: { type: S.STRING(255), allowNull: false }, template_title: { type: S.STRING(160), allowNull: true },
      created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    });
    if (!tables.includes('ClinicalTreatmentTemplateDefaultRevisions')) await q.createTable('ClinicalTreatmentTemplateDefaultRevisions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, preference_id: ref('ClinicalTreatmentTemplateDefaults', 'id', S.BIGINT.UNSIGNED),
      clinic_id: ref('Clinicas', 'id_clinica'), version_number: { type: S.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: S.JSON, allowNull: false },
      actor_id: { type: S.INTEGER, allowNull: false }, command_key: { type: S.STRING(120), allowNull: false }, command_hash: { type: S.STRING(64), allowNull: false },
      created_at: { type: S.DATE, allowNull: false },
    });
    for (const [table, fields, name, unique] of [
      ['ClinicalTreatmentTemplateDefaults', ['clinic_id','treatment_id'], 'clinical_treatment_template_default_scope', true],
      ['ClinicalTreatmentTemplateDefaults', ['clinic_id','id'], 'clinical_treatment_template_default_page', false],
      ['ClinicalTreatmentTemplateDefaultRevisions', ['preference_id','version_number'], 'clinical_treatment_template_default_revision_once', true],
      ['ClinicalTreatmentTemplateDefaultRevisions', ['clinic_id','actor_id','command_key'], 'clinical_treatment_template_default_command_once', true],
    ]) if (!(await q.showIndex(table)).some(index => index.name === name)) await q.addIndex(table, fields, { name, unique });
    if (!(await q.describeTable('AppointmentClinicalReports')).template_default_origin) await q.addColumn('AppointmentClinicalReports', 'template_default_origin', { type: S.JSON, allowNull: true });
  },
  async down() { throw Error('clinical_template_default_history_preserved_rollback_code_only'); },
};
