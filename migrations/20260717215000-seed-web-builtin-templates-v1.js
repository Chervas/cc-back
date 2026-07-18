'use strict';

const { BUILTIN_WEB_TEMPLATES_V1 } = require('../src/contracts/webBuiltinTemplatesV1');
const { assertValidWebDocument } = require('../src/lib/webDocument');

const IDS = BUILTIN_WEB_TEMPLATES_V1.map((item) => item.id);

function tableNameOf(value) {
  return typeof value === 'string' ? value : value?.tableName || value?.table_name || null;
}

async function webTemplatesExists(queryInterface) {
  const tables = await queryInterface.showAllTables();
  return tables.some((value) => tableNameOf(value) === 'WebTemplates');
}

async function existingRows(queryInterface) {
  return queryInterface.sequelize.query(
    'SELECT id, catalog_key, version, document_hash FROM WebTemplates WHERE id IN (:ids)',
    {
      replacements: { ids: IDS },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
}

function expectedRows() {
  const now = new Date('2026-07-17T00:00:00.000Z');
  return BUILTIN_WEB_TEMPLATES_V1.map((template) => {
    const integrity = assertValidWebDocument(template.document);
    return {
      id: template.id,
      scope_type: 'global',
      clinica_id: null,
      grupo_clinica_id: null,
      scope_key: 'global',
      catalog_key: template.catalog_key,
      name: template.name,
      description: template.description,
      category: template.category,
      schema_version: 1,
      document: JSON.stringify(template.document),
      document_hash: integrity.hash,
      version: 1,
      compatibility: JSON.stringify({
        schema_version: 1,
        renderer_min: 'clinicaclick-web-renderer/1.0.0',
        breakpoints: ['desktop', 'tablet', 'mobile'],
      }),
      preview_asset_id: null,
      is_public: true,
      status: 'active',
      created_by_user_id: null,
      updated_by_user_id: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
  });
}

module.exports = {
  IDS,

  async up(queryInterface) {
    if (!await webTemplatesExists(queryInterface)) {
      const error = new Error('Falta la tabla requerida WebTemplates.');
      error.code = 'web_builtin_template_seed_missing_dependency';
      throw error;
    }
    const expected = expectedRows();
    const byId = new Map((await existingRows(queryInterface)).map((row) => [String(row.id), row]));
    for (const row of expected) {
      const existing = byId.get(row.id);
      if (!existing) continue;
      if (
        existing.catalog_key !== row.catalog_key
        || Number(existing.version) !== row.version
        || existing.document_hash !== row.document_hash
      ) {
        const error = new Error(`La plantilla builtin ${row.id} existe con contenido incompatible.`);
        error.code = 'web_builtin_template_seed_conflict';
        throw error;
      }
    }
    const missing = expected.filter((row) => !byId.has(row.id));
    if (missing.length) await queryInterface.bulkInsert('WebTemplates', missing);
  },

  async down(queryInterface) {
    if (!await webTemplatesExists(queryInterface)) return;
    const expected = new Map(expectedRows().map((row) => [row.id, row]));
    const current = await existingRows(queryInterface);
    const modified = current.filter((row) => expected.get(String(row.id))?.document_hash !== row.document_hash);
    if (modified.length) {
      const error = new Error('No se eliminan plantillas builtin modificadas.');
      error.code = 'web_builtin_template_seed_down_conflict';
      throw error;
    }
    await queryInterface.bulkDelete('WebTemplates', { id: IDS });
  },
};
