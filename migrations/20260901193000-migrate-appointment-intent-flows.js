'use strict';

const {
  INTENT_MIGRATION_KEY,
  LEGACY_EXECUTION_ALLOWLIST_KEY,
  buildMessageReceivedTemplateNodes,
  hasCanonicalIntentMigration,
  transformLegacyIntentNodes,
} = require('../src/lib/automation-intent-migration');

const MESSAGE_TEMPLATE_PUBLIC_ID = 'flw_message_received_after_hours';
const MESSAGE_TEMPLATE_KEY = 'system_message_received_after_hours';
const MESSAGE_CATALOG_NAME = 'auto_message_received_after_hours';
const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const CATALOG_PIN_SNAPSHOT_KEY = 'appointment_intent_catalog_pins_v1';
const MESSAGE_TRIGGER_CONFIG = Object.freeze({
  channel_scope: 'all_connected',
  channels: [],
  timing: 'clinic_closed',
  only_unclaimed: true,
  response_buffer_seconds: 90,
  runtime_fallback_enabled: false,
});

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function jsonEquivalent(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function pickExistingColumns(payload, definition) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => definition[key]));
}

async function ensureSnapshotTable(queryInterface, Sequelize) {
  const tables = await queryInterface.showAllTables();
  const normalized = new Set(tables.map((table) => (
    typeof table === 'string' ? table : table?.tableName || table?.table_name
  )));
  if (normalized.has(SNAPSHOT_TABLE)) return;
  await queryInterface.createTable(SNAPSHOT_TABLE, {
    id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
    snapshot_key: { type: Sequelize.STRING(120), allowNull: false, unique: 'uq_automation_intent_snapshot_key' },
    payload: { type: Sequelize.JSON, allowNull: false },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  });
}

async function saveSnapshot(queryInterface, snapshotKey, payload, now, transaction) {
  const existing = await queryInterface.sequelize.query(
    `SELECT id FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1 FOR UPDATE`,
    {
      replacements: { snapshotKey },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  if (existing[0]) return;
  await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
    snapshot_key: snapshotKey,
    payload: JSON.stringify(payload),
    created_at: now,
    updated_at: now,
  }], { transaction });
}

async function loadSnapshot(queryInterface, snapshotKey, transaction) {
  const rows = await queryInterface.sequelize.query(
    `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
    {
      replacements: { snapshotKey },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return parseJson(rows[0]?.payload, []);
}

function containsLegacyIntentPreset(nodes) {
  return (Array.isArray(nodes) ? nodes : []).some((node) => (
    node?.type === 'condition/ai_analysis'
    && ['confirm_appointment', 'appointment_unconfirmed_reply'].includes(cleanString(node?.config?.preset_key))
  ));
}

async function loadTemplates(queryInterface, transaction) {
  return queryInterface.sequelize.query(
    `
      SELECT id, public_id, template_key, version, engine_version, name, description,
             trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
             entry_node_id, nodes, published_at, published_by, created_by
      FROM AutomationFlowTemplatesV2
      WHERE engine_version = 'v2'
      ORDER BY public_id ASC, version ASC, id ASC
      FOR UPDATE
    `,
    { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
  );
}

function groupTemplateFamilies(rows) {
  const families = new Map();
  for (const row of rows) {
    const key = cleanString(row.public_id) || `template:${cleanString(row.template_key)}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(row);
  }
  return families;
}

async function validateMigrationCandidates(queryInterface, transaction) {
  const { validateFlowPayloadForInternalUse } = require('../src/controllers/automationsV2.controller');
  const rows = await loadTemplates(queryInterface, transaction);
  const families = groupTemplateFamilies(rows);
  const failures = [];

  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const latest = publishedRows[publishedRows.length - 1] || null;
    if (!latest) continue;
    const latestNodes = parseJson(latest.nodes, []);
    if (hasCanonicalIntentMigration(latestNodes)) {
      const predecessor = [...publishedRows]
        .reverse()
        .find((row) => Number(row.version) < Number(latest.version));
      if (
        Number(latest.is_active) !== 1
        && predecessor
        && Number(predecessor.is_active) === 1
        && containsLegacyIntentPreset(parseJson(predecessor.nodes, []))
      ) {
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { is_active: false, updated_at: now },
          { id: predecessor.id },
          { transaction },
        );
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { is_active: true, updated_at: now },
          { id: latest.id },
          { transaction },
        );
        published.push({
          public_id: latest.public_id,
          template_key: latest.template_key,
          previous_version: Number(predecessor.version),
          version: Number(latest.version),
          preserved_active: true,
          replaced_nodes: 0,
        });
      }
      continue;
    }
    if (!containsLegacyIntentPreset(latestNodes)) continue;
    const transformed = transformLegacyIntentNodes(latestNodes);
    if (!transformed.changed) continue;
    const validation = await validateFlowPayloadForInternalUse({
      entry_node_id: latest.entry_node_id,
      trigger_type: latest.trigger_type,
      nodes: transformed.nodes,
    });
    if (!validation.ok) {
      failures.push({
        public_id: cleanString(latest.public_id) || null,
        template_key: cleanString(latest.template_key) || null,
        codes: Array.from(new Set(validation.errors.map((error) => cleanString(error?.code) || 'invalid_flow'))),
      });
    }
  }

  const sourceValidation = await validateFlowPayloadForInternalUse({
    entry_node_id: 'N1',
    trigger_type: 'message_received',
    nodes: buildMessageReceivedTemplateNodes(),
  });
  if (!sourceValidation.ok) {
    failures.push({
      public_id: MESSAGE_TEMPLATE_PUBLIC_ID,
      template_key: MESSAGE_TEMPLATE_KEY,
      codes: Array.from(new Set(sourceValidation.errors.map((error) => cleanString(error?.code) || 'invalid_flow'))),
    });
  }

  if (failures.length) {
    throw new Error(`appointment_intent_migration_validation_failed:${JSON.stringify(failures)}`);
  }
}

async function allowlistExistingExecutions(queryInterface, now, transaction) {
  const rows = await queryInterface.sequelize.query(
    `
      SELECT execution.id, execution.template_version_id, execution.status, execution.context, template.nodes
      FROM FlowExecutionsV2 execution
      INNER JOIN AutomationFlowTemplatesV2 template ON template.id = execution.template_version_id
      WHERE execution.status IN ('running', 'waiting')
      FOR UPDATE
    `,
    { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
  );
  let allowlisted = 0;
  for (const row of rows) {
    if (!containsLegacyIntentPreset(parseJson(row.nodes, []))) continue;
    const context = parseJson(row.context, {});
    const compatibility = context.__legacy_automation_compatibility
      && typeof context.__legacy_automation_compatibility === 'object'
      ? context.__legacy_automation_compatibility
      : {};
    context.__legacy_automation_compatibility = {
      ...compatibility,
      [LEGACY_EXECUTION_ALLOWLIST_KEY]: {
        allowed: true,
        template_version_id: Number(row.template_version_id),
        status_at_cutover: cleanString(row.status),
        allowlisted_at: now.toISOString(),
      },
    };
    await queryInterface.bulkUpdate(
      'FlowExecutionsV2',
      { context: JSON.stringify(context), updated_at: now },
      { id: row.id },
      { transaction },
    );
    allowlisted += 1;
  }
  return allowlisted;
}

async function publishMigratedVersions(queryInterface, now, transaction) {
  const rows = await loadTemplates(queryInterface, transaction);
  const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const families = groupTemplateFamilies(rows);
  const published = [];

  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const latest = publishedRows[publishedRows.length - 1] || null;
    if (!latest) continue;
    const latestNodes = parseJson(latest.nodes, []);
    if (hasCanonicalIntentMigration(latestNodes) || !containsLegacyIntentPreset(latestNodes)) continue;
    const transformed = transformLegacyIntentNodes(latestNodes);
    if (!transformed.changed) continue;

    const nextVersion = Math.max(...familyRows.map((row) => Number(row.version) || 0)) + 1;
    const payload = pickExistingColumns({
      public_id: latest.public_id,
      template_key: latest.template_key,
      version: nextVersion,
      engine_version: latest.engine_version || 'v2',
      name: latest.name,
      description: latest.description,
      trigger_type: latest.trigger_type,
      trigger_config: JSON.stringify(parseJson(latest.trigger_config, null)),
      is_active: Number(latest.is_active) === 1,
      is_system: Number(latest.is_system) === 1,
      clinic_id: latest.clinic_id,
      group_id: latest.group_id,
      entry_node_id: latest.entry_node_id,
      nodes: JSON.stringify(transformed.nodes),
      published_at: now,
      published_by: latest.published_by || latest.created_by,
      created_by: latest.created_by,
      created_at: now,
      updated_at: now,
    }, definition);

    await queryInterface.bulkUpdate(
      'AutomationFlowTemplatesV2',
      { is_active: false, updated_at: now },
      { id: latest.id },
      { transaction },
    );
    await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [payload], { transaction });
    published.push({
      public_id: latest.public_id,
      template_key: latest.template_key,
      previous_version: Number(latest.version),
      version: nextVersion,
      preserved_active: Number(latest.is_active) === 1,
      replaced_nodes: transformed.replaced,
    });
  }
  return published;
}

async function ensureMessageReceivedTemplate(queryInterface, now, transaction) {
  const existing = await queryInterface.sequelize.query(
    `
      SELECT id, version, trigger_type, trigger_config, is_active, is_system,
             clinic_id, group_id, entry_node_id, nodes, published_at
      FROM AutomationFlowTemplatesV2
      WHERE public_id = :publicId
      ORDER BY version DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `,
    {
      replacements: { publicId: MESSAGE_TEMPLATE_PUBLIC_ID },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  if (existing[0]) {
    const source = existing[0];
    const sourceIsCanonical = cleanString(source.trigger_type) === 'message_received'
      && Number(source.is_system) === 1
      && source.clinic_id === null
      && source.group_id === null
      && cleanString(source.entry_node_id) === 'N1'
      && !!source.published_at
      && jsonEquivalent(parseJson(source.trigger_config, {}), MESSAGE_TRIGGER_CONFIG)
      && jsonEquivalent(parseJson(source.nodes, []), buildMessageReceivedTemplateNodes());
    if (!sourceIsCanonical) {
      throw new Error(`message_received_source_conflict:${Number(source.id)}`);
    }
    if (Number(source.is_active) !== 1) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: true, updated_at: now },
        { id: source.id },
        { transaction },
      );
    }
    return Number(source.id);
  }

  const definition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const payload = pickExistingColumns({
    public_id: MESSAGE_TEMPLATE_PUBLIC_ID,
    template_key: MESSAGE_TEMPLATE_KEY,
    version: 1,
    engine_version: 'v2',
    name: 'Gestionar mensajes recibidos fuera de horario',
    description: 'Clasifica mensajes no reclamados, aplica acciones seguras sobre una unica cita y deriva el resto a recepcion.',
    trigger_type: 'message_received',
    trigger_config: JSON.stringify(MESSAGE_TRIGGER_CONFIG),
    is_active: true,
    is_system: true,
    clinic_id: null,
    group_id: null,
    entry_node_id: 'N1',
    nodes: JSON.stringify(buildMessageReceivedTemplateNodes()),
    published_at: now,
    published_by: 1,
    created_by: 1,
    created_at: now,
    updated_at: now,
  }, definition);
  await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [payload], { transaction });
  const inserted = await queryInterface.sequelize.query(
    'SELECT id FROM AutomationFlowTemplatesV2 WHERE public_id = :publicId AND version = 1 LIMIT 1',
    {
      replacements: { publicId: MESSAGE_TEMPLATE_PUBLIC_ID },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return Number(inserted[0]?.id) || null;
}

async function ensureMessageReceivedCatalog(queryInterface, now, transaction) {
  const definition = await queryInterface.describeTable('AutomationFlowCatalog');
  const existing = await queryInterface.sequelize.query(
    'SELECT id FROM AutomationFlowCatalog WHERE name = :name LIMIT 1 FOR UPDATE',
    {
      replacements: { name: MESSAGE_CATALOG_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  const payload = pickExistingColumns({
    display_name: 'Gestionar mensajes fuera de horario',
    description: 'Analiza mensajes no reclamados cuando la clinica esta cerrada y deja a recepcion las decisiones no seguras.',
    trigger_type: 'message_received',
    steps: JSON.stringify([]),
    template_key: MESSAGE_TEMPLATE_PUBLIC_ID,
    template_version: null,
    is_generic: true,
    is_active: true,
    is_default_for_trigger: false,
    updated_at: now,
  }, definition);
  if (existing[0]?.id) {
    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      payload,
      { id: existing[0].id },
      { transaction },
    );
    return Number(existing[0].id);
  }
  await queryInterface.bulkInsert('AutomationFlowCatalog', [{
    name: MESSAGE_CATALOG_NAME,
    ...payload,
    created_at: now,
  }], { transaction });
  const inserted = await queryInterface.sequelize.query(
    'SELECT id FROM AutomationFlowCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name: MESSAGE_CATALOG_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return Number(inserted[0]?.id) || null;
}

async function unpinCatalogVersions(queryInterface, now, transaction, published = []) {
  const migratedFamilies = new Set(
    published
      .flatMap((item) => [cleanString(item?.public_id), cleanString(item?.template_key)])
      .filter(Boolean),
  );
  if (!migratedFamilies.size) return 0;
  const rows = await queryInterface.sequelize.query(
    `
      SELECT id, template_key, template_version
      FROM AutomationFlowCatalog
      WHERE template_version IS NOT NULL
      FOR UPDATE
    `,
    { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
  );
  const affected = rows
    .filter((row) => migratedFamilies.has(cleanString(row.template_key)))
    .map((row) => ({ id: Number(row.id), template_version: Number(row.template_version) }));
  await saveSnapshot(queryInterface, CATALOG_PIN_SNAPSHOT_KEY, affected, now, transaction);
  let updated = 0;
  for (const row of rows) {
    if (!migratedFamilies.has(cleanString(row.template_key))) continue;
    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      { template_version: null, updated_at: now },
      { id: row.id },
      { transaction },
    );
    updated += 1;
  }
  return updated;
}

async function restoreCatalogVersionPins(queryInterface, now, transaction) {
  const rows = await loadSnapshot(queryInterface, CATALOG_PIN_SNAPSHOT_KEY, transaction);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Number.isInteger(Number(row?.id)) || !Number.isInteger(Number(row?.template_version))) continue;
    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      { template_version: Number(row.template_version), updated_at: now },
      { id: Number(row.id) },
      { transaction },
    );
  }
}

async function clearLegacyExecutionAllowlist(queryInterface, now, transaction) {
  const rows = await queryInterface.sequelize.query(
    `
      SELECT id, context
      FROM FlowExecutionsV2
      WHERE JSON_EXTRACT(context, '$.__legacy_automation_compatibility') IS NOT NULL
      FOR UPDATE
    `,
    { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
  );
  for (const row of rows) {
    const context = parseJson(row.context, {});
    const compatibility = context.__legacy_automation_compatibility;
    if (!compatibility || typeof compatibility !== 'object') continue;
    delete compatibility[LEGACY_EXECUTION_ALLOWLIST_KEY];
    if (Object.keys(compatibility).length) {
      context.__legacy_automation_compatibility = compatibility;
    } else {
      delete context.__legacy_automation_compatibility;
    }
    await queryInterface.bulkUpdate(
      'FlowExecutionsV2',
      { context: JSON.stringify(context), updated_at: now },
      { id: row.id },
      { transaction },
    );
  }
}

async function rollbackMigratedVersions(queryInterface, now, transaction) {
  const rows = await loadTemplates(queryInterface, transaction);
  const families = groupTemplateFamilies(rows);
  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const migratedRows = publishedRows.filter((row) => hasCanonicalIntentMigration(parseJson(row.nodes, [])));
    const firstMigrated = migratedRows[0] || null;
    if (!firstMigrated) continue;
    const active = [...publishedRows].reverse().find((row) => Number(row.is_active) === 1);
    if (
      active
      && Number(active.version) > Number(firstMigrated.version)
      && !hasCanonicalIntentMigration(parseJson(active.nodes, []))
    ) continue;
    for (const migrated of migratedRows) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: false, updated_at: now },
        { id: migrated.id },
        { transaction },
      );
    }
    const predecessor = [...publishedRows].reverse().find((row) => Number(row.version) < Number(firstMigrated.version));
    if (predecessor && Number(firstMigrated.is_active) === 1) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: true, updated_at: now },
        { id: predecessor.id },
        { transaction },
      );
    }
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await ensureSnapshotTable(queryInterface, Sequelize);
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      await validateMigrationCandidates(queryInterface, transaction);
      await allowlistExistingExecutions(queryInterface, now, transaction);
      const published = await publishMigratedVersions(queryInterface, now, transaction);
      await ensureMessageReceivedTemplate(queryInterface, now, transaction);
      await ensureMessageReceivedCatalog(queryInterface, now, transaction);
      await unpinCatalogVersions(queryInterface, now, transaction, published);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      await rollbackMigratedVersions(queryInterface, now, transaction);
      await restoreCatalogVersionPins(queryInterface, now, transaction);
      await clearLegacyExecutionAllowlist(queryInterface, now, transaction);
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: false, updated_at: now },
        { public_id: MESSAGE_TEMPLATE_PUBLIC_ID },
        { transaction },
      );
      await queryInterface.bulkUpdate(
        'AutomationFlowCatalog',
        { is_active: false, updated_at: now },
        { name: MESSAGE_CATALOG_NAME },
        { transaction },
      );
    });
    await queryInterface.dropTable(SNAPSHOT_TABLE);
  },

  __test: {
    INTENT_MIGRATION_KEY,
    MESSAGE_CATALOG_NAME,
    MESSAGE_TEMPLATE_KEY,
    MESSAGE_TEMPLATE_PUBLIC_ID,
    MESSAGE_TRIGGER_CONFIG,
    CATALOG_PIN_SNAPSHOT_KEY,
    SNAPSHOT_TABLE,
    clearLegacyExecutionAllowlist,
    containsLegacyIntentPreset,
    ensureMessageReceivedTemplate,
    jsonEquivalent,
    restoreCatalogVersionPins,
    unpinCatalogVersions,
  },
};
