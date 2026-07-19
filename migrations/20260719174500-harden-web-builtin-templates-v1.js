'use strict';

const {
  BUILTIN_WEB_TEMPLATES_V1,
  BUILTIN_WEB_TEMPLATE_COMPATIBILITY,
  BUILTIN_WEB_TEMPLATES_REVISION,
} = require('../src/contracts/webBuiltinTemplatesV1');
const { assertValidWebDocument } = require('../src/lib/webDocument');

const TABLE = 'WebTemplates';
const MIGRATION_TIME = new Date('2026-07-19T17:45:00.000Z');

// Hashes de la revisión ya sembrada en entornos existentes. La actualización
// solo se permite desde uno de estos hashes conocidos o desde el hash final;
// una plantilla editada por un usuario/operador nunca se pisa silenciosamente.
const LEGACY_DOCUMENT_HASHES = Object.freeze({
  '61e5a73e-bcd5-47f0-a145-a0ddcbd76001': Object.freeze([
    '603c815f1ce3d3aa5ef5cd673a5d8a2df87a66d93dfe67d8f94119d3288f09c8',
  ]),
  '61e5a73e-bcd5-47f0-a145-a0ddcbd76002': Object.freeze([
    'dce4c89a51e8ca2590141416b63fdb4c60d6d235e2873032f2c1bdd5cc2c4441',
  ]),
  '61e5a73e-bcd5-47f0-a145-a0ddcbd76003': Object.freeze([
    // Revisión sembrada originalmente, antes de añadir email al formulario.
    '54ae3906d423c89cb298ecabb7b41f52c2995f10aa466711fe12e766cb59ea8a',
    'abba8a38ada8bf0a238cc94d7970314dde16a0efa98c3cb1a5dad94343341505',
  ]),
  '61e5a73e-bcd5-47f0-a145-a0ddcbd76004': Object.freeze([
    // Revisión sembrada originalmente, antes de añadir email al formulario.
    '7a1d175df7502fea0d70f11cfe2018d2575097f2d32eb93c49497ce3fb12cfd1',
    '199d3e760934e241e6eb3701b3f408954b325321a1fe0d04aeb4a9e7ac8bbde6',
  ]),
  '61e5a73e-bcd5-47f0-a145-a0ddcbd76005': Object.freeze([
    '378d44a7f08c3ca8691974ce562feb07824816cc57755384deb7d7d913d662c3',
  ]),
});

function tableNameOf(value) {
  return typeof value === 'string' ? value : value?.tableName || value?.table_name || null;
}

function migrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function desiredRows() {
  return BUILTIN_WEB_TEMPLATES_V1.map((template) => ({
    ...template,
    version: 1,
    document_hash: assertValidWebDocument(template.document).hash,
  }));
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isTrue(value) {
  return value === true || Number(value) === 1;
}

function hasBuiltinIdentity(row, desired) {
  const allowedCategory = desired.catalog_key === 'qualification-form-v1'
    ? new Set(['form', 'qualification'])
    : new Set([desired.category]);
  return row.catalog_key === desired.catalog_key
    && Number(row.version) === desired.version
    && Number(row.schema_version) === 1
    && row.scope_type === 'global'
    && row.scope_key === 'global'
    && row.clinica_id === null
    && row.grupo_clinica_id === null
    && row.created_by_user_id === null
    && row.updated_by_user_id === null
    && isTrue(row.is_public)
    && row.status === 'active'
    && row.deleted_at === null
    && allowedCategory.has(row.category);
}

function isCurrent(row, desired) {
  const compatibility = parseJsonObject(row.compatibility);
  return row.document_hash === desired.document_hash
    && row.name === desired.name
    && row.description === desired.description
    && row.category === desired.category
    && Number(compatibility.builtin_revision) === BUILTIN_WEB_TEMPLATES_REVISION;
}

async function assertTableExists(queryInterface) {
  const tables = await queryInterface.showAllTables();
  if (!tables.some((value) => tableNameOf(value) === TABLE)) {
    throw migrationError(
      'web_builtin_template_hardening_missing_dependency',
      `Falta la tabla requerida ${TABLE}.`
    );
  }
}

async function loadRows(queryInterface) {
  const ids = BUILTIN_WEB_TEMPLATES_V1.map((template) => template.id);
  return queryInterface.sequelize.query(
    `SELECT id, catalog_key, name, description, category, schema_version, version, document_hash,
            compatibility, scope_type, scope_key, clinica_id, grupo_clinica_id,
            is_public, status, created_by_user_id, updated_by_user_id, deleted_at
       FROM WebTemplates
      WHERE id IN (:ids)`,
    {
      replacements: { ids },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
}

async function verifyCurrent(queryInterface) {
  const desired = desiredRows();
  const rows = await loadRows(queryInterface);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const template of desired) {
    const row = byId.get(template.id);
    if (!row || !hasBuiltinIdentity(row, template) || !isCurrent(row, template)) {
      throw migrationError(
        'web_builtin_template_hardening_verification_failed',
        `No se pudo verificar la revisión segura de la plantilla builtin ${template.id}.`,
        { template_id: template.id }
      );
    }
  }
}

module.exports = {
  LEGACY_DOCUMENT_HASHES,

  async up(queryInterface) {
    await assertTableExists(queryInterface);
    const desired = desiredRows();
    const rows = await loadRows(queryInterface);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const pending = [];

    for (const template of desired) {
      const row = byId.get(template.id);
      if (!row) {
        throw migrationError(
          'web_builtin_template_hardening_template_missing',
          `No se encontró la plantilla builtin ${template.id} que debía reconciliarse.`,
          { template_id: template.id }
        );
      }
      if (!hasBuiltinIdentity(row, template)) {
        throw migrationError(
          'web_builtin_template_hardening_identity_conflict',
          `La plantilla ${template.id} no conserva la identidad builtin esperada.`,
          { template_id: template.id }
        );
      }
      const legacyHashes = LEGACY_DOCUMENT_HASHES[template.id] || [];
      if (![...legacyHashes, template.document_hash].includes(row.document_hash)) {
        throw migrationError(
          'web_builtin_template_hardening_content_conflict',
          `La plantilla ${template.id} contiene una edición no reconocida y no se sobrescribirá.`,
          { template_id: template.id }
        );
      }
      if (isCurrent(row, template)) continue;

      pending.push({ row, template });
    }

    for (const { row, template } of pending) {
      await queryInterface.bulkUpdate(
        TABLE,
        {
          name: template.name,
          description: template.description,
          category: template.category,
          schema_version: 1,
          document: JSON.stringify(template.document),
          document_hash: template.document_hash,
          compatibility: JSON.stringify(BUILTIN_WEB_TEMPLATE_COMPATIBILITY),
          updated_at: MIGRATION_TIME,
        },
        {
          id: template.id,
          catalog_key: template.catalog_key,
          version: template.version,
          schema_version: row.schema_version,
          scope_type: 'global',
          scope_key: 'global',
          clinica_id: null,
          grupo_clinica_id: null,
          created_by_user_id: null,
          updated_by_user_id: null,
          is_public: row.is_public,
          status: 'active',
          deleted_at: null,
          category: row.category,
          name: row.name,
          description: row.description,
          document_hash: row.document_hash,
        }
      );
    }

    await verifyCurrent(queryInterface);
  },

  // Corrección de seguridad de contenido: no reintroducimos teléfonos
  // ficticios al hacer rollback de código.
  async down() {},
};
