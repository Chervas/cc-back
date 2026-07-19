'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const migration = require('../../../migrations/20260719174500-harden-web-builtin-templates-v1');
const {
  BUILTIN_WEB_TEMPLATES_V1,
  BUILTIN_WEB_TEMPLATES_REVISION,
} = require('../../contracts/webBuiltinTemplatesV1');
const { assertValidWebDocument } = require('../../lib/webDocument');

function sameWhereValue(actual, expected) {
  if (expected === null) return actual === null;
  return actual === expected;
}

class FakeQueryInterface {
  constructor(rows = []) {
    this.hasTable = true;
    this.rows = rows.map((row) => ({ ...row }));
    this.updateCount = 0;
    this.sequelize = {
      QueryTypes: { SELECT: 'SELECT' },
      query: async (_sql, options = {}) => {
        const ids = new Set((options.replacements?.ids || []).map(String));
        return this.rows
          .filter((row) => ids.size === 0 || ids.has(String(row.id)))
          .map((row) => ({ ...row }));
      },
    };
  }

  async showAllTables() {
    return this.hasTable ? ['WebTemplates'] : [];
  }

  async bulkUpdate(table, values, where) {
    assert.equal(table, 'WebTemplates');
    for (const row of this.rows) {
      if (!Object.entries(where).every(([key, expected]) => sameWhereValue(row[key], expected))) continue;
      Object.assign(row, values);
      this.updateCount += 1;
    }
  }
}

function legacyRows() {
  return BUILTIN_WEB_TEMPLATES_V1.map((template) => ({
    id: template.id,
    catalog_key: template.catalog_key,
    name: template.name,
    description: template.catalog_key === 'local-call-whatsapp-v1'
      ? 'Prioriza llamada y WhatsApp, manteniendo un formulario como alternativa.'
      : template.description,
    category: template.category,
    schema_version: 1,
    version: 1,
    document_hash: migration.LEGACY_DOCUMENT_HASHES[template.id],
    document: '{}',
    compatibility: JSON.stringify({
      schema_version: 1,
      renderer_min: 'clinicaclick-web-renderer/1.0.0',
      breakpoints: ['desktop', 'tablet', 'mobile'],
    }),
    scope_type: 'global',
    scope_key: 'global',
    clinica_id: null,
    grupo_clinica_id: null,
    is_public: true,
    status: 'active',
    created_by_user_id: null,
    updated_by_user_id: null,
    deleted_at: null,
  }));
}

test('reconcilia por CAS las cinco filas builtin conocidas y es idempotente', async () => {
  const userTemplate = {
    ...legacyRows()[0],
    id: '12345678-1234-4234-8234-123456789012',
    scope_type: 'clinic',
    scope_key: 'clinic:59',
    clinica_id: 59,
    is_public: false,
    created_by_user_id: 77,
    document_hash: 'a'.repeat(64),
  };
  const queryInterface = new FakeQueryInterface([...legacyRows(), userTemplate]);

  await migration.up(queryInterface);
  assert.equal(queryInterface.updateCount, 5);
  const desiredById = new Map(BUILTIN_WEB_TEMPLATES_V1.map((template) => [template.id, template]));
  for (const row of queryInterface.rows.filter((item) => desiredById.has(item.id))) {
    const desired = desiredById.get(row.id);
    assert.equal(row.document_hash, assertValidWebDocument(desired.document).hash);
    assert.equal(JSON.parse(row.compatibility).builtin_revision, BUILTIN_WEB_TEMPLATES_REVISION);
    assert.doesNotMatch(row.document, /\+3490{6,}|900000000|example\.(?:com|org|net)|localhost/i);
  }
  assert.equal(queryInterface.rows.at(-1).document_hash, userTemplate.document_hash);
  assert.equal(queryInterface.rows.at(-1).document, userTemplate.document);

  const updatesAfterFirstRun = queryInterface.updateCount;
  await migration.up(queryInterface);
  assert.equal(queryInterface.updateCount, updatesAfterFirstRun);
  await migration.down(queryInterface);
  assert.equal(queryInterface.updateCount, updatesAfterFirstRun);
});

test('rechaza contenido builtin desconocido sin sobrescribirlo', async () => {
  const rows = legacyRows();
  rows[3].document_hash = 'f'.repeat(64);
  rows[3].document = '{"custom":true}';
  const queryInterface = new FakeQueryInterface(rows);

  await assert.rejects(
    () => migration.up(queryInterface),
    (error) => error.code === 'web_builtin_template_hardening_content_conflict'
  );
  assert.equal(queryInterface.rows[3].document_hash, 'f'.repeat(64));
  assert.equal(queryInterface.rows[3].document, '{"custom":true}');
});

test('rechaza IDs builtin apropiados por usuario y dependencias incompletas', async () => {
  const claimedRows = legacyRows();
  claimedRows[0].created_by_user_id = 91;
  const claimed = new FakeQueryInterface(claimedRows);
  await assert.rejects(
    () => migration.up(claimed),
    (error) => error.code === 'web_builtin_template_hardening_identity_conflict'
  );
  assert.equal(claimed.updateCount, 0);

  const missingRow = new FakeQueryInterface(legacyRows().slice(1));
  await assert.rejects(
    () => migration.up(missingRow),
    (error) => error.code === 'web_builtin_template_hardening_template_missing'
  );

  const missingTable = new FakeQueryInterface();
  missingTable.hasTable = false;
  await assert.rejects(
    () => migration.up(missingTable),
    (error) => error.code === 'web_builtin_template_hardening_missing_dependency'
  );
});
