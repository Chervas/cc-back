'use strict';

const {
  CLASSIFY_INTENT_PRESET_CONFIG,
  cloneConfirmAppointmentPresetConfig,
} = require('../src/lib/automation-intent-contract');

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_PREFIX = 'appointment_ai_grounding_v3_';

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function refreshClassifyIntentConfig(config) {
  const canonicalFields = new Map(
    CLASSIFY_INTENT_PRESET_CONFIG.output_fields.map((field) => [field.name, field]),
  );
  const currentFields = Array.isArray(config?.output_fields) ? config.output_fields : [];

  return {
    ...config,
    instruction: CLASSIFY_INTENT_PRESET_CONFIG.instruction,
    context_sources: cloneJson(CLASSIFY_INTENT_PRESET_CONFIG.context_sources),
    output_fields: currentFields.map((field) => {
      const canonical = canonicalFields.get(field?.name);
      return canonical
        ? { ...field, description: canonical.description }
        : field;
    }),
  };
}

function refreshNode(node) {
  if (node?.type !== 'condition/ai_analysis') return node;
  const presetKey = String(node?.config?.preset_key || '').trim();

  if (presetKey === 'confirm_appointment') {
    const fieldNames = new Set(
      (Array.isArray(node.config?.output_fields) ? node.config.output_fields : [])
        .map((field) => String(field?.name || '').trim()),
    );
    const isStructuredContract = Number(node.config?.preset_contract_version || 0) >= 2
      || (
        fieldNames.has('confirma_asistencia')
        && fieldNames.has('requiere_respuesta')
        && fieldNames.has('motivo')
      );
    if (!isStructuredContract) return node;
    return {
      ...node,
      config: cloneConfirmAppointmentPresetConfig(node.config),
    };
  }

  if (presetKey === 'classify_intent') {
    return {
      ...node,
      config: refreshClassifyIntentConfig(node.config),
    };
  }

  return node;
}

function refreshNodes(nodes) {
  let changed = false;
  const refreshed = (Array.isArray(nodes) ? nodes : []).map((node) => {
    const next = refreshNode(node);
    if (JSON.stringify(next) !== JSON.stringify(node)) changed = true;
    return next;
  });
  return { changed, nodes: refreshed };
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existing = await queryInterface.sequelize.query(
        `SELECT id
           FROM ${SNAPSHOT_TABLE}
          WHERE LEFT(snapshot_key, :snapshotPrefixLength) = :snapshotPrefix
          LIMIT 1
          FOR UPDATE`,
        {
          replacements: {
            snapshotPrefix: SNAPSHOT_PREFIX,
            snapshotPrefixLength: SNAPSHOT_PREFIX.length,
          },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existing.length) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT template.id, template.nodes
           FROM AutomationFlowTemplatesV2 template
           INNER JOIN (
             SELECT template_key, MAX(version) AS version
               FROM AutomationFlowTemplatesV2
              GROUP BY template_key
           ) latest
             ON latest.template_key = template.template_key
            AND latest.version = template.version
          FOR UPDATE`,
        {
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );

      const now = new Date();
      for (const row of rows) {
        const previousNodes = parseJson(row.nodes, []);
        const refreshed = refreshNodes(previousNodes);
        if (!refreshed.changed) continue;

        await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
          snapshot_key: `${SNAPSHOT_PREFIX}${Number(row.id)}`,
          payload: JSON.stringify({
            template_id: Number(row.id),
            previous_nodes: previousNodes,
          }),
          created_at: now,
          updated_at: now,
        }], { transaction });

        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { nodes: JSON.stringify(refreshed.nodes), updated_at: now },
          { id: Number(row.id) },
          { transaction },
        );
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key, payload
           FROM ${SNAPSHOT_TABLE}
          WHERE LEFT(snapshot_key, :snapshotPrefixLength) = :snapshotPrefix
          ORDER BY id ASC
          FOR UPDATE`,
        {
          replacements: {
            snapshotPrefix: SNAPSHOT_PREFIX,
            snapshotPrefixLength: SNAPSHOT_PREFIX.length,
          },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );

      for (const row of snapshots) {
        const snapshot = parseJson(row.payload, null);
        if (!snapshot?.template_id || !Array.isArray(snapshot.previous_nodes)) continue;
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { nodes: JSON.stringify(snapshot.previous_nodes), updated_at: new Date() },
          { id: Number(snapshot.template_id) },
          { transaction },
        );
      }

      await queryInterface.sequelize.query(
        `DELETE FROM ${SNAPSHOT_TABLE}
          WHERE LEFT(snapshot_key, :snapshotPrefixLength) = :snapshotPrefix`,
        {
          replacements: {
            snapshotPrefix: SNAPSHOT_PREFIX,
            snapshotPrefixLength: SNAPSHOT_PREFIX.length,
          },
          transaction,
        },
      );
    });
  },

  _test: {
    SNAPSHOT_PREFIX,
    refreshClassifyIntentConfig,
    refreshNode,
    refreshNodes,
  },
};
