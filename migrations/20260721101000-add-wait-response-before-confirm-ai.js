'use strict';

const MIGRATION_KEY = 'confirm_ai_wait_response_guard_v1';
const WAIT_TIMEOUT_DURATION = 12;
const WAIT_TIMEOUT_UNIT = 'hours';
const WAIT_BUFFER_DELAY_SECONDS = 90;

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function pickExistingColumns(payload, tableDefinition) {
  return Object.entries(payload).reduce((result, [key, value]) => {
    if (tableDefinition[key]) result[key] = value;
    return result;
  }, {});
}

function buildUniqueNodeId(existingIds) {
  const highestNumericId = Array.from(existingIds).reduce((highest, nodeId) => {
    const match = /^N(\d+)$/.exec(cleanString(nodeId));
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  let index = highestNumericId + 1;
  let candidate = `N${index}`;
  while (existingIds.has(candidate)) {
    index += 1;
    candidate = `N${index}`;
  }
  existingIds.add(candidate);
  return candidate;
}

function isConfirmAppointmentAiNode(node) {
  return node?.type === 'condition/ai_analysis'
    && cleanString(node?.config?.preset_key) === 'confirm_appointment';
}

function isWaitResponseNode(node) {
  return node?.type === 'delay/wait_response';
}

function hasMigrationWaitResponse(nodes) {
  return (Array.isArray(nodes) ? nodes : []).some((node) => (
    isWaitResponseNode(node)
    && cleanString(node?.config?.migration_key) === MIGRATION_KEY
  ));
}

function buildNodeMap(nodes) {
  return new Map((Array.isArray(nodes) ? nodes : [])
    .map((node) => [cleanString(node?.id), node])
    .filter(([nodeId]) => !!nodeId));
}

function collectIncomingEdges(nodes) {
  const incoming = new Map();
  for (const source of Array.isArray(nodes) ? nodes : []) {
    const sourceId = cleanString(source?.id);
    if (!sourceId) continue;
    for (const [outputKey, target] of Object.entries(source.outputs || {})) {
      const targetId = cleanString(target);
      if (!targetId) continue;
      if (!incoming.has(targetId)) incoming.set(targetId, []);
      incoming.get(targetId).push({ source, sourceId, outputKey });
    }
  }
  return incoming;
}

function findUpstreamOutboundNodeIds(nodes, startNodeId) {
  const incoming = collectIncomingEdges(nodes);
  const visited = new Set();
  const queue = [cleanString(startNodeId)];
  const outboundIds = new Set();

  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    for (const edge of incoming.get(currentId) || []) {
      if (edge.source?.type === 'action/send_whatsapp' || edge.source?.type === 'action/send_email') {
        outboundIds.add(edge.sourceId);
        continue;
      }
      queue.push(edge.sourceId);
    }
  }

  return Array.from(outboundIds);
}

function inferListensToNodeId(nodes, sourceNode) {
  const sourceId = cleanString(sourceNode?.id);
  if (!sourceId) return null;
  if (sourceNode?.type === 'action/send_whatsapp' || sourceNode?.type === 'action/send_email') {
    return sourceId;
  }
  const upstreamOutboundIds = findUpstreamOutboundNodeIds(nodes, sourceId);
  if (upstreamOutboundIds.length === 1) return upstreamOutboundIds[0];
  return sourceId;
}

function midpointPosition(sourceNode, targetNode, offsetIndex) {
  const sourcePosition = sourceNode?.position && typeof sourceNode.position === 'object'
    ? sourceNode.position
    : null;
  const targetPosition = targetNode?.position && typeof targetNode.position === 'object'
    ? targetNode.position
    : null;
  const sourceX = Number(sourcePosition?.x);
  const sourceY = Number(sourcePosition?.y);
  const targetX = Number(targetPosition?.x);
  const targetY = Number(targetPosition?.y);
  if (Number.isFinite(sourceX) && Number.isFinite(sourceY) && Number.isFinite(targetX) && Number.isFinite(targetY)) {
    return {
      x: Math.round((sourceX + targetX) / 2),
      y: Math.round((sourceY + targetY) / 2) + (offsetIndex * 80),
    };
  }
  if (Number.isFinite(sourceX) && Number.isFinite(sourceY)) {
    return { x: sourceX, y: sourceY + 160 + (offsetIndex * 80) };
  }
  return { x: 100, y: 100 + (offsetIndex * 120) };
}

function buildWaitResponseNode({ id, listensToNodeId, sourceNode, targetNode, offsetIndex }) {
  return {
    id,
    type: 'delay/wait_response',
    config: {
      migration_key: MIGRATION_KEY,
      timeout_duration: WAIT_TIMEOUT_DURATION,
      timeout_unit: WAIT_TIMEOUT_UNIT,
      listens_to_node_id: listensToNodeId || null,
      response_buffer_enabled: true,
      response_buffer_delay_seconds: WAIT_BUFFER_DELAY_SECONDS,
    },
    outputs: {
      on_timeout: null,
      on_response: cleanString(targetNode?.id) || null,
    },
    position: midpointPosition(sourceNode, targetNode, offsetIndex),
  };
}

function addWaitResponseBeforeConfirmAppointmentAi(nodes) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const nodeMap = buildNodeMap(safeNodes);
  const incoming = collectIncomingEdges(safeNodes);
  const existingIds = new Set(safeNodes.map((node) => cleanString(node?.id)).filter(Boolean));
  const rewiredNodes = safeNodes.map((node) => ({
    ...node,
    outputs: { ...(node.outputs || {}) },
  }));
  const rewiredMap = buildNodeMap(rewiredNodes);
  const waitNodes = [];
  let offsetIndex = 0;

  for (const targetNode of safeNodes) {
    if (!isConfirmAppointmentAiNode(targetNode)) continue;
    const targetId = cleanString(targetNode.id);
    const targetIncoming = incoming.get(targetId) || [];
    for (const edge of targetIncoming) {
      if (isWaitResponseNode(edge.source)) continue;
      const sourceNode = nodeMap.get(edge.sourceId);
      const rewiredSource = rewiredMap.get(edge.sourceId);
      if (!sourceNode || !rewiredSource) continue;
      if (cleanString(rewiredSource.outputs?.[edge.outputKey]) !== targetId) continue;

      const waitNodeId = buildUniqueNodeId(existingIds);
      const waitNode = buildWaitResponseNode({
        id: waitNodeId,
        listensToNodeId: inferListensToNodeId(safeNodes, sourceNode),
        sourceNode,
        targetNode,
        offsetIndex,
      });
      rewiredSource.outputs[edge.outputKey] = waitNodeId;
      waitNodes.push(waitNode);
      offsetIndex += 1;
    }
  }

  return {
    nodes: waitNodes.length ? [...rewiredNodes, ...waitNodes] : safeNodes,
    changed: waitNodes.length > 0,
    inserted: waitNodes.length,
  };
}

async function loadFlowRows(queryInterface, transaction) {
  return queryInterface.sequelize.query(
    `
      SELECT id, public_id, template_key, version, engine_version, name, description,
             trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
             entry_node_id, nodes, published_at, published_by, created_by
      FROM AutomationFlowTemplatesV2
      WHERE engine_version = 'v2'
      ORDER BY public_id ASC, version ASC
      FOR UPDATE
    `,
    {
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
}

function groupRowsByFamily(rows) {
  const families = new Map();
  rows.forEach((row) => {
    const key = cleanString(row.public_id) || `template:${cleanString(row.template_key)}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(row);
  });
  return families;
}

async function publishPatchedVersions(queryInterface, now, transaction) {
  const rows = await loadFlowRows(queryInterface, transaction);
  const tableDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const families = groupRowsByFamily(rows);
  const published = [];

  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const active = [...publishedRows]
      .reverse()
      .find((row) => Number(row.is_active) === 1);
    if (!active) continue;

    const activeNodes = parseJson(active.nodes, []);
    if (!Array.isArray(activeNodes)) continue;
    const transformed = addWaitResponseBeforeConfirmAppointmentAi(activeNodes);
    if (!transformed.changed) continue;

    const nextVersion = Math.max(...familyRows.map((row) => Number(row.version) || 0)) + 1;
    const payload = pickExistingColumns({
      public_id: active.public_id,
      template_key: active.template_key,
      version: nextVersion,
      engine_version: active.engine_version || 'v2',
      name: active.name,
      description: active.description,
      trigger_type: active.trigger_type,
      trigger_config: JSON.stringify(parseJson(active.trigger_config, null)),
      is_active: true,
      is_system: !!active.is_system,
      clinic_id: active.clinic_id,
      group_id: active.group_id,
      entry_node_id: active.entry_node_id,
      nodes: JSON.stringify(transformed.nodes),
      published_at: now,
      published_by: active.published_by || active.created_by,
      created_by: active.created_by,
      created_at: now,
      updated_at: now,
    }, tableDefinition);

    for (const row of publishedRows) {
      if (Number(row.is_active) !== 1) continue;
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: false, updated_at: now },
        { id: row.id },
        { transaction }
      );
    }
    await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [payload], { transaction });
    published.push({
      public_id: active.public_id,
      template_key: active.template_key,
      previous_version: Number(active.version),
      version: nextVersion,
    });
  }

  const catalogTable = await queryInterface.describeTable('AutomationFlowCatalog').catch(() => ({}));
  for (const version of published) {
    const patch = pickExistingColumns({
      template_version: version.version,
      last_propagated_at: now,
      last_propagated_template_version: version.version,
      updated_at: now,
    }, catalogTable);
    if (Object.keys(patch).length) {
      await queryInterface.bulkUpdate(
        'AutomationFlowCatalog',
        patch,
        { template_key: version.public_id },
        { transaction }
      );
    }
  }

  return published;
}

async function rollbackPatchedVersions(queryInterface, now, transaction) {
  const rows = await loadFlowRows(queryInterface, transaction);
  const families = groupRowsByFamily(rows);
  const restored = [];

  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const patchedRows = publishedRows
      .filter((row) => hasMigrationWaitResponse(parseJson(row.nodes, [])));
    const firstPatched = patchedRows[0] || null;
    if (!firstPatched) continue;

    for (const patched of patchedRows) {
      if (Number(patched.is_active) !== 1) continue;
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: false, updated_at: now },
        { id: patched.id },
        { transaction }
      );
    }

    const activePublished = [...publishedRows]
      .reverse()
      .find((row) => Number(row.is_active) === 1);
    const hasNewerNonPatchedActive = activePublished
      && Number(activePublished.version) > Number(firstPatched.version)
      && !hasMigrationWaitResponse(parseJson(activePublished.nodes, []));
    if (hasNewerNonPatchedActive) continue;

    const predecessor = [...publishedRows]
      .reverse()
      .find((row) => Number(row.version) < Number(firstPatched.version));
    if (!predecessor) continue;
    if (Number(predecessor.is_active) !== 1) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: true, updated_at: now },
        { id: predecessor.id },
        { transaction }
      );
    }
    restored.push({
      public_id: firstPatched.public_id,
      version: Number(predecessor.version),
    });
  }

  const catalogTable = await queryInterface.describeTable('AutomationFlowCatalog').catch(() => ({}));
  for (const version of restored) {
    const patch = pickExistingColumns({
      template_version: version.version,
      last_propagated_at: now,
      last_propagated_template_version: version.version,
      updated_at: now,
    }, catalogTable);
    if (Object.keys(patch).length) {
      await queryInterface.bulkUpdate(
        'AutomationFlowCatalog',
        patch,
        { template_key: version.public_id },
        { transaction }
      );
    }
  }

  return restored;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await publishPatchedVersions(queryInterface, new Date(), transaction);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await rollbackPatchedVersions(queryInterface, new Date(), transaction);
    });
  },

  __test: {
    MIGRATION_KEY,
    WAIT_TIMEOUT_DURATION,
    WAIT_TIMEOUT_UNIT,
    addWaitResponseBeforeConfirmAppointmentAi,
    hasMigrationWaitResponse,
    inferListensToNodeId,
  },
};
