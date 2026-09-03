'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'hard_cut_retired_appointment_intent_runtime_v1';
const RETIRED_PRESET_KEYS = new Set([
  'confirm_appointment',
  'appointment_unconfirmed_reply',
]);

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function cleanNodeId(value) {
  const normalized = String(value ?? '').trim();
  return normalized && normalized !== 'null' ? normalized : null;
}

function containsRetiredPreset(nodes) {
  return (Array.isArray(nodes) ? nodes : []).some((node) => (
    node?.type === 'condition/ai_analysis'
    && RETIRED_PRESET_KEYS.has(String(node?.config?.preset_key || '').trim())
  ));
}

function containsCanonicalPreset(nodes) {
  return (Array.isArray(nodes) ? nodes : []).some((node) => (
    node?.type === 'condition/ai_analysis'
    && String(node?.config?.preset_key || '').trim() === 'classify_intent'
  ));
}

function mapNodes(nodes) {
  return new Map(
    (Array.isArray(nodes) ? nodes : [])
      .filter((node) => cleanNodeId(node?.id))
      .map((node) => [cleanNodeId(node.id), node]),
  );
}

function validateExecutionRebind(execution, sourceNodes, targetNodes) {
  const sourceMap = mapNodes(sourceNodes);
  const targetMap = mapNodes(targetNodes);
  const currentNodeId = cleanNodeId(execution.current_node_id);
  const waitingMeta = parseJson(execution.waiting_meta, {});
  const referencedNodeIds = [
    currentNodeId,
    cleanNodeId(waitingMeta.on_response),
    cleanNodeId(waitingMeta.on_timeout),
    cleanNodeId(waitingMeta.next_node_id),
    cleanNodeId(waitingMeta.listens_to_node_id),
  ].filter(Boolean);

  for (const nodeId of referencedNodeIds) {
    const sourceNode = sourceMap.get(nodeId);
    const targetNode = targetMap.get(nodeId);
    if (!sourceNode || !targetNode) {
      throw new Error(`appointment_intent_hard_cut_node_missing:${execution.id}:${nodeId}`);
    }
    if (String(sourceNode.type || '') !== String(targetNode.type || '')) {
      throw new Error(`appointment_intent_hard_cut_node_type_changed:${execution.id}:${nodeId}`);
    }
  }
}

async function readSnapshot(queryInterface, transaction) {
  const rows = await queryInterface.sequelize.query(
    `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
    {
      replacements: { snapshotKey: SNAPSHOT_KEY },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  return parseJson(rows[0]?.payload, null);
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      if (await readSnapshot(queryInterface, transaction)) return;

      const executions = await queryInterface.sequelize.query(
        `
          SELECT execution.id, execution.template_version_id, execution.status,
                 execution.current_node_id, execution.waiting_meta,
                 template.public_id, template.trigger_type, template.nodes AS source_nodes
          FROM FlowExecutionsV2 execution
          INNER JOIN AutomationFlowTemplatesV2 template
            ON template.id = execution.template_version_id
          WHERE execution.status IN ('running', 'waiting')
          ORDER BY execution.id ASC
          FOR UPDATE
        `,
        { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
      );
      const templates = await queryInterface.sequelize.query(
        `
          SELECT id, public_id, version, trigger_type, published_at, nodes
          FROM AutomationFlowTemplatesV2
          WHERE published_at IS NOT NULL
          ORDER BY public_id ASC, version DESC, id DESC
          FOR UPDATE
        `,
        { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
      );

      const templatesByPublicId = new Map();
      for (const template of templates) {
        if (!templatesByPublicId.has(template.public_id)) {
          templatesByPublicId.set(template.public_id, []);
        }
        templatesByPublicId.get(template.public_id).push(template);
      }

      const rebound = [];
      for (const execution of executions) {
        const sourceNodes = parseJson(execution.source_nodes, []);
        if (!containsRetiredPreset(sourceNodes)) continue;

        const target = (templatesByPublicId.get(execution.public_id) || []).find((candidate) => {
          const candidateNodes = parseJson(candidate.nodes, []);
          return String(candidate.trigger_type || '') === String(execution.trigger_type || '')
            && !containsRetiredPreset(candidateNodes)
            && containsCanonicalPreset(candidateNodes);
        });
        if (!target) {
          throw new Error(`appointment_intent_hard_cut_target_missing:${execution.id}:${execution.public_id}`);
        }

        const targetNodes = parseJson(target.nodes, []);
        validateExecutionRebind(execution, sourceNodes, targetNodes);
        await queryInterface.bulkUpdate(
          'FlowExecutionsV2',
          { template_version_id: Number(target.id), updated_at: new Date() },
          { id: Number(execution.id), template_version_id: Number(execution.template_version_id) },
          { transaction },
        );
        rebound.push({
          execution_id: Number(execution.id),
          source_template_version_id: Number(execution.template_version_id),
          target_template_version_id: Number(target.id),
        });
      }

      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ rebound }),
        created_at: now,
        updated_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshot = await readSnapshot(queryInterface, transaction);
      for (const item of Array.isArray(snapshot?.rebound) ? snapshot.rebound : []) {
        await queryInterface.bulkUpdate(
          'FlowExecutionsV2',
          {
            template_version_id: Number(item.source_template_version_id),
            updated_at: new Date(),
          },
          {
            id: Number(item.execution_id),
            template_version_id: Number(item.target_template_version_id),
            status: ['running', 'waiting'],
          },
          { transaction },
        );
      }
      await queryInterface.bulkDelete(
        SNAPSHOT_TABLE,
        { snapshot_key: SNAPSHOT_KEY },
        { transaction },
      );
    });
  },
  _test: {
    containsCanonicalPreset,
    containsRetiredPreset,
    validateExecutionRebind,
  },
};
