'use strict';

const COLUMNS = Object.freeze({
  web_project_id: {
    type: 'STRING',
    length: 36,
    references: { model: 'WebProjects', key: 'id' },
  },
  web_revision_id: {
    type: 'STRING',
    length: 36,
    references: { model: 'WebRevisions', key: 'id' },
  },
  web_page_id: {
    type: 'STRING',
    length: 36,
    references: { model: 'WebPages', key: 'id' },
  },
  web_publication_id: {
    type: 'STRING',
    length: 36,
    references: { model: 'WebPublications', key: 'id' },
  },
  web_artifact_id: {
    type: 'STRING',
    length: 36,
    references: { model: 'WebArtifacts', key: 'id' },
  },
  web_form_id: { type: 'STRING', length: 64 },
});

const INDEXES = Object.freeze([
  { name: 'idx_leadintakes_web_project_created', fields: ['web_project_id', 'created_at'] },
  { name: 'idx_leadintakes_web_publication_created', fields: ['web_publication_id', 'created_at'] },
  { name: 'idx_leadintakes_web_page_created', fields: ['web_page_id', 'created_at'] },
]);

async function addColumnIfMissing(queryInterface, Sequelize, name, descriptor) {
  const table = await queryInterface.describeTable('LeadIntakes');
  if (table[name]) {
    const actualType = String(table[name].type || '').toUpperCase().replace(/\s+/g, '');
    const expectedType = `VARCHAR(${descriptor.length})`;
    if (table[name].allowNull === false || !actualType.includes(expectedType)) {
      const error = new Error(`LeadIntakes.${name} existe con un contrato incompatible`);
      error.code = 'web_lead_attribution_migration_incompatible_column';
      error.details = { column: name, expected_type: expectedType, actual_type: actualType };
      throw error;
    }
    return;
  }
  await queryInterface.addColumn('LeadIntakes', name, {
    type: descriptor.type === 'STRING' ? Sequelize.STRING(descriptor.length) : descriptor.type,
    allowNull: true,
    ...(descriptor.references ? {
      references: descriptor.references,
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    } : {}),
  });
}

async function addIndexIfMissing(queryInterface, index) {
  const current = await queryInterface.showIndex('LeadIntakes');
  const existing = current.find((item) => item.name === index.name);
  if (existing) {
    const fields = (existing.fields || []).map((field) => field.attribute || field.name);
    if (fields.join(',') !== index.fields.join(',') || Boolean(existing.unique)) {
      const error = new Error(`${index.name} existe con campos incompatibles`);
      error.code = 'web_lead_attribution_migration_incompatible_index';
      throw error;
    }
    return;
  }
  await queryInterface.addIndex('LeadIntakes', index.fields, { name: index.name });
}

module.exports = {
  COLUMNS,
  INDEXES,
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map((value) => (
      typeof value === 'string' ? value : value?.tableName || value?.table_name
    ));
    const required = ['LeadIntakes', 'WebProjects', 'WebRevisions', 'WebPages', 'WebPublications', 'WebArtifacts'];
    const missing = required.filter((name) => !tables.includes(name));
    if (missing.length) {
      const error = new Error(`Faltan tablas requeridas: ${missing.join(', ')}`);
      error.code = 'web_lead_attribution_migration_missing_dependency';
      throw error;
    }
    for (const [name, descriptor] of Object.entries(COLUMNS)) {
      await addColumnIfMissing(queryInterface, Sequelize, name, descriptor);
    }
    for (const index of INDEXES) await addIndexIfMissing(queryInterface, index);
  },
  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map((value) => (
      typeof value === 'string' ? value : value?.tableName || value?.table_name
    ));
    if (!tables.includes('LeadIntakes')) return;
    const table = await queryInterface.describeTable('LeadIntakes');
    // MySQL may use one of these composite indexes to support the FK created
    // with addColumn(). Removing that index first fails with ER_DROP_INDEX_FK
    // (1553). Dropping the owned nullable columns first lets MySQL/Sequelize
    // retire their FKs and dependent indexes safely. Afterwards we remove only
    // named indexes that survived (other dialects/test doubles may retain them).
    for (const name of Object.keys(COLUMNS).reverse()) {
      if (table[name]) await queryInterface.removeColumn('LeadIntakes', name);
    }
    const indexes = await queryInterface.showIndex('LeadIntakes');
    for (const index of [...INDEXES].reverse()) {
      if (indexes.some((item) => item.name === index.name)) await queryInterface.removeIndex('LeadIntakes', index.name);
    }
  },
};
