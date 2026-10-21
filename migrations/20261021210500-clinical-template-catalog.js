'use strict';
module.exports = {
  async up(q, S) {
    const tables = (await q.showAllTables()).map(value => typeof value === 'string' ? value : value.tableName || value.table_name);
    if (!tables.includes('ClinicalTemplateCatalogEntries')) await q.createTable('ClinicalTemplateCatalogEntries', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, public_id: { type: S.STRING(36), allowNull: false, unique: true },
      catalog_key: { type: S.STRING(80), allowNull: false, unique: true }, current_version: { type: S.INTEGER.UNSIGNED, allowNull: false },
      published_version: { type: S.INTEGER.UNSIGNED, allowNull: true }, created_by: { type: S.INTEGER, allowNull: false }, updated_by: { type: S.INTEGER, allowNull: false },
      created_at: { type: S.DATE, allowNull: false }, updated_at: { type: S.DATE, allowNull: false },
    });
    if (!tables.includes('ClinicalTemplateCatalogVersions')) await q.createTable('ClinicalTemplateCatalogVersions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, entry_id: { type: S.BIGINT.UNSIGNED, allowNull: false,
        references: { model: 'ClinicalTemplateCatalogEntries', key: 'id' }, onDelete: 'RESTRICT' },
      version_number: { type: S.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: S.JSON, allowNull: false }, sha256: { type: S.STRING(64), allowNull: false },
      published_at: { type: S.DATE, allowNull: true }, actor_id: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    if (!(await q.showIndex('ClinicalTemplateCatalogVersions')).some(index => index.name === 'clinical_catalog_version_once'))
      await q.addIndex('ClinicalTemplateCatalogVersions', ['entry_id', 'version_number'], { unique: true, name: 'clinical_catalog_version_once' });
    if (!tables.includes('ClinicalTemplateCatalogAdoptions')) await q.createTable('ClinicalTemplateCatalogAdoptions', {
      id: { type: S.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, clinic_id: { type: S.INTEGER, allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' }, onDelete: 'RESTRICT' },
      entry_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'ClinicalTemplateCatalogEntries', key: 'id' }, onDelete: 'RESTRICT' },
      source_version_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'ClinicalTemplateCatalogVersions', key: 'id' }, onDelete: 'RESTRICT' },
      source_version: { type: S.INTEGER.UNSIGNED, allowNull: false }, source_sha256: { type: S.STRING(64), allowNull: false },
      local_template_id: { type: S.BIGINT.UNSIGNED, allowNull: false, references: { model: 'ClinicalEpisodeTemplates', key: 'id' }, onDelete: 'RESTRICT' },
      local_version: { type: S.INTEGER.UNSIGNED, allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    if (!(await q.showIndex('ClinicalTemplateCatalogAdoptions')).some(index => index.name === 'clinical_catalog_adoption_once'))
      await q.addIndex('ClinicalTemplateCatalogAdoptions', ['clinic_id', 'source_version_id'], { unique: true, name: 'clinical_catalog_adoption_once' });
    if (!(await q.showIndex('ClinicalTemplateCatalogAdoptions')).some(index => index.name === 'clinical_catalog_adoption_scope'))
      await q.addIndex('ClinicalTemplateCatalogAdoptions', ['clinic_id', 'entry_id'], { name: 'clinical_catalog_adoption_scope' });
  },
  async down() { throw Error('clinical_catalog_history_preserved: roll back compatible code; catalog versions and clinic copies must be retained.'); },
};
