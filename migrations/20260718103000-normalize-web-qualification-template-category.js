'use strict';

const TABLE = 'WebTemplates';
const TEMPLATE = Object.freeze({
  id: '61e5a73e-bcd5-47f0-a145-a0ddcbd76005',
  catalogKey: 'qualification-form-v1',
  version: 1,
});
const LEGACY_CATEGORY = 'form';
const CANONICAL_CATEGORY = 'qualification';
const MIGRATION_TIME = new Date('2026-07-18T10:30:00.000Z');

function tableNameOf(value) {
  return typeof value === 'string' ? value : value?.tableName || value?.table_name || null;
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function assertTableExists(queryInterface) {
  const tables = await queryInterface.showAllTables();
  if (!tables.some((value) => tableNameOf(value) === TABLE)) {
    throw migrationError(
      'web_qualification_category_missing_dependency',
      `Falta la tabla requerida ${TABLE}.`
    );
  }
}

async function loadTemplate(queryInterface) {
  const rows = await queryInterface.sequelize.query(
    `SELECT id, catalog_key, version, category, scope_type, clinica_id, grupo_clinica_id, is_public
       FROM WebTemplates
      WHERE id = :id`,
    {
      replacements: { id: TEMPLATE.id },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  if (rows.length !== 1) {
    throw migrationError(
      'web_qualification_category_template_missing',
      'No se ha encontrado la plantilla builtin de cualificación esperada.'
    );
  }
  const row = rows[0];
  if (
    row.catalog_key !== TEMPLATE.catalogKey
    || Number(row.version) !== TEMPLATE.version
    || row.scope_type !== 'global'
    || row.clinica_id !== null
    || row.grupo_clinica_id !== null
    || !(row.is_public === true || Number(row.is_public) === 1)
  ) {
    throw migrationError(
      'web_qualification_category_template_conflict',
      'La identidad o el scope de la plantilla builtin de cualificación no coincide con el contrato esperado.'
    );
  }
  return row;
}

async function transitionCategory(queryInterface, fromCategory, toCategory) {
  await assertTableExists(queryInterface);
  const before = await loadTemplate(queryInterface);
  if (before.category === toCategory) return;
  if (before.category !== fromCategory) {
    throw migrationError(
      'web_qualification_category_template_conflict',
      `La plantilla builtin de cualificación usa una categoría inesperada: ${before.category}.`
    );
  }
  await queryInterface.bulkUpdate(
    TABLE,
    { category: toCategory, updated_at: MIGRATION_TIME },
    { id: TEMPLATE.id, catalog_key: TEMPLATE.catalogKey, version: TEMPLATE.version, category: fromCategory }
  );
  const after = await loadTemplate(queryInterface);
  if (after.category !== toCategory) {
    throw migrationError(
      'web_qualification_category_update_failed',
      'No se ha podido normalizar de forma atómica la categoría de la plantilla builtin de cualificación.'
    );
  }
}

module.exports = {
  async up(queryInterface) {
    await transitionCategory(queryInterface, LEGACY_CATEGORY, CANONICAL_CATEGORY);
  },

  async down(queryInterface) {
    await transitionCategory(queryInterface, CANONICAL_CATEGORY, LEGACY_CATEGORY);
  },
};
