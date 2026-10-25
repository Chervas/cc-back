'use strict';
// Selected additive migration. Originals and historic episode references are never rewritten.
module.exports = {
  async up(q, S) {
    const tables = (await q.showAllTables()).map(item => typeof item === 'string' ? item : item.tableName || item.table_name);
    const ref = (model, key, type = S.INTEGER) => ({ type, allowNull: false, references: { model, key }, onDelete: 'RESTRICT' });
    const dates = { created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false } };
    const number = { type: S.INTEGER.UNSIGNED, allowNull: false };
    if (!tables.includes('ClinicalPhotoPairs')) await q.createTable('ClinicalPhotoPairs', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: { type: S.STRING(36), allowNull: false, unique: true },
      clinic_id: ref('Clinicas', 'id_clinica'), patient_id: ref('Pacientes', 'id_paciente'),
      title: { type: S.STRING(180), allowNull: false }, service_ref: { type: S.JSON, allowNull: true }, treatment_id: { type: S.INTEGER, allowNull: true },
      scope_key: { type: S.STRING(64), allowNull: false }, before_photo: { type: S.JSON, allowNull: false }, after_photo: { type: S.JSON, allowNull: false },
      before_asset_id: ref('ClinicalPrivateAssets', 'id'), after_asset_id: ref('ClinicalPrivateAssets', 'id'),
      status: { type: S.STRING(16), allowNull: false, defaultValue: 'active' }, version_number: { ...number, defaultValue: 1 },
      idempotency_key: { type: S.STRING(120), allowNull: false }, creation_hash: { type: S.STRING(64), allowNull: false },
      created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false }, ...dates,
    });
    if (!tables.includes('ClinicalPhotoPairRevisions')) await q.createTable('ClinicalPhotoPairRevisions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, pair_id: ref('ClinicalPhotoPairs', 'id', S.BIGINT.UNSIGNED),
      before_asset_id: ref('ClinicalPrivateAssets', 'id'), after_asset_id: ref('ClinicalPrivateAssets', 'id'),
      version_number: number, snapshot: { type: S.JSON, allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false },
      change_type: { type: S.STRING(20), allowNull: false }, command_key: S.STRING(120), command_hash: S.STRING(64), created_at: dates.created_at,
    });
    if (!tables.includes('ClinicalAttachmentLibraryStates')) await q.createTable('ClinicalAttachmentLibraryStates', {
      asset_id: { ...ref('ClinicalPrivateAssets', 'id'), primaryKey: true }, clinic_id: ref('Clinicas', 'id_clinica'), patient_id: ref('Pacientes', 'id_paciente'),
      classification: { type: S.STRING(16), allowNull: false }, status: { type: S.STRING(16), allowNull: false, defaultValue: 'active' },
      version_number: { ...number, defaultValue: 1 }, updated_by: { type: S.INTEGER, allowNull: false }, ...dates,
    });
    if (!tables.includes('ClinicalAttachmentLibraryRevisions')) await q.createTable('ClinicalAttachmentLibraryRevisions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, asset_id: ref('ClinicalPrivateAssets', 'id'),
      version_number: number, snapshot: { type: S.JSON, allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false },
      change_type: { type: S.STRING(20), allowNull: false }, command_key: S.STRING(120), command_hash: S.STRING(64), created_at: dates.created_at,
    });
    const indexes = [
      ['ClinicalPhotoPairs', ['clinic_id', 'patient_id', 'idempotency_key'], 'clinical_photo_pair_create_once', true],
      ['ClinicalPhotoPairs', ['clinic_id', 'patient_id', 'scope_key', 'status', 'id'], 'clinical_photo_pair_scope'],
      ['ClinicalPhotoPairRevisions', ['pair_id', 'version_number'], 'clinical_photo_pair_revision_once', true],
      ['ClinicalPhotoPairRevisions', ['pair_id', 'command_key'], 'clinical_photo_pair_command_once', true],
      ['ClinicalAttachmentLibraryStates', ['clinic_id', 'patient_id', 'status', 'asset_id'], 'clinical_attachment_library_scope'],
      ['ClinicalAttachmentLibraryRevisions', ['asset_id', 'version_number'], 'clinical_attachment_library_revision_once', true],
      ['ClinicalAttachmentLibraryRevisions', ['asset_id', 'command_key'], 'clinical_attachment_library_command_once', true],
    ];
    for (const [table, fields, name, unique = false] of indexes) if (!(await q.showIndex(table)).some(index => index.name === name)) await q.addIndex(table, fields, { name, unique });
  },
  async down() { throw Error('clinical_gallery_history_preserved_rollback_code_only'); },
};
