'use strict';

const BASE_TEMPLATE_NAME = 'clinicaclick_recordatorio_mismo_dia_primera_visita';
const BASE_DISPLAY_NAME = 'Recordatorio mismo día 8:00 (primera visita)';
const VARIANT_TEMPLATE_NAME = 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil';
const VARIANT_DISPLAY_NAME = 'Recordatorio mismo día 8:00 (primera visita - clínica con difícil acceso)';
const IMAGE_SAMPLE_URL = 'https://media.clinicaclick.com/templates/reviews/team-example.jpg';
const TRIGGER_TYPE = 'appointment_reminder_window';
const MIGRATION_KEY = 'access_guidance_reminder_explicit_branch_v1';
const DELIVERY_SLOT = 'same_day_first_visit_reminder';

const TEMPLATE_BODY = [
  'Hola {{1}}, tenemos todo preparado para recibirte hoy a las {{2}}.',
  '',
  'Estamos en {{3}}',
  '',
  'Te dejo un enlace con la ubicación: {{4}}',
  '',
  '¿Sabes llegar? ¿Necesitas alguna indicación? Para facilitarte te dejo más indicaciones:',
  '',
  '{{5}}',
  '',
  'Si necesitas ayuda, respóndenos por aquí.',
].join('\n');

const TEMPLATE_VARIABLES = [
  { position: 1, name: 'nombre_paciente', example: 'María', description: 'Nombre del paciente' },
  { position: 2, name: 'hora_cita', example: '10:30', description: 'Hora de la cita programada' },
  { position: 3, name: 'direccion_clinica', example: 'Calle Mayor 123, Madrid', description: 'Dirección completa de la clínica' },
  { position: 4, name: 'url_como_llegar_clinica', example: 'https://www.google.com/maps/dir/?api=1&destination=Clinica', description: 'Enlace de Google Maps con indicaciones para llegar a la clínica' },
  { position: 5, name: 'indicaciones_acceso_clinica', example: 'Entra por el pasaje lateral junto a la farmacia y sube a la primera planta.', description: 'Indicaciones adicionales para encontrar el acceso de la clínica' },
];

const TEMPLATE_COMPONENTS = [
  { type: 'HEADER', format: 'IMAGE', example: { header_handle: [IMAGE_SAMPLE_URL] } },
  {
    type: 'BODY',
    text: TEMPLATE_BODY,
    example: {
      body_text: [[
        'María',
        '10:30',
        'Calle Mayor 123, Madrid',
        'https://www.google.com/maps/dir/?api=1&destination=Clinica',
        'Entra por el pasaje lateral junto a la farmacia y sube a la primera planta.',
      ]],
    },
  },
];

const VARIANT_VARIABLES_NAMED = {
  nombre_paciente: '{{paciente.nombre}}',
  hora_cita: '{{cita.hora}}',
  direccion_clinica: '{{clinica.direccion}}',
  url_como_llegar_clinica: '{{clinica.url_como_llegar}}',
  indicaciones_acceso_clinica: '{{clinica.indicaciones_acceso}}',
};

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = canonicalizeJson(value[key]);
      return result;
    }, {});
}

function jsonEquivalent(left, right) {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
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

function isBaseReminderNode(node, baseCatalogId) {
  if (node?.type !== 'action/send_whatsapp' || !node.config) return false;
  const templateName = cleanString(node.config.template_name);
  const catalogTemplateId = Number.parseInt(String(node.config.catalog_template_id || ''), 10);
  return templateName === BASE_TEMPLATE_NAME
    || (!!baseCatalogId && catalogTemplateId === Number(baseCatalogId));
}

function isSameDayEightReminder(row, nodes) {
  const entryNode = (Array.isArray(nodes) ? nodes : [])
    .find((node) => cleanString(node?.id) === cleanString(row.entry_node_id));
  const config = parseJson(row.trigger_config, null) || entryNode?.config || {};
  return cleanString(config.schedule_moment).toLowerCase() === 'same_day'
    && cleanString(config.schedule_time_mode).toLowerCase() === 'custom'
    && cleanString(config.custom_time) === '08:00';
}

function hasCanonicalBranch(nodes) {
  return (Array.isArray(nodes) ? nodes : []).some((node) => (
    node?.type === 'condition/field_check'
    && cleanString(node?.config?.migration_key) === MIGRATION_KEY
  ));
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

function collectDescendantIds(nodes, startNodeId) {
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [cleanString(node?.id), node]));
  const visited = new Set();
  const queue = [cleanString(startNodeId)];
  while (queue.length) {
    const currentId = queue.shift();
    const current = nodeMap.get(currentId);
    if (!current) continue;
    Object.values(current.outputs || {}).forEach((target) => {
      const targetId = cleanString(target);
      if (!targetId || visited.has(targetId)) return;
      visited.add(targetId);
      queue.push(targetId);
    });
  }
  return visited;
}

function buildExplicitBranchNodes(nodes, baseCatalogId, variantCatalogId) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  if (hasCanonicalBranch(safeNodes)) return safeNodes;
  const baseNodes = safeNodes.filter((node) => isBaseReminderNode(node, baseCatalogId));
  if (baseNodes.length !== 1) {
    throw new Error(`access_guidance_expected_one_base_send:${baseNodes.length}`);
  }

  const baseNode = baseNodes[0];
  const baseId = cleanString(baseNode.id);
  const existingIds = new Set(safeNodes.map((node) => cleanString(node?.id)).filter(Boolean));
  const conditionId = buildUniqueNodeId(existingIds);
  const variantId = buildUniqueNodeId(existingIds);
  const joinId = buildUniqueNodeId(existingIds);
  const originalSuccess = baseNode.outputs?.on_success ?? null;
  const originalFail = baseNode.outputs?.on_fail ?? null;
  const basePosition = baseNode.position || { x: 100, y: 240 };
  const baseX = Number(basePosition.x) || 100;
  const baseY = Number(basePosition.y) || 240;
  const descendants = collectDescendantIds(safeNodes, baseId);
  const verticalShift = 360;

  const rewired = safeNodes.map((node) => {
    const nodeId = cleanString(node?.id);
    const outputs = Object.fromEntries(
      Object.entries(node.outputs || {}).map(([key, target]) => [
        key,
        cleanString(target) === baseId && nodeId !== baseId ? conditionId : target,
      ])
    );
    if (nodeId === baseId) {
      return {
        ...node,
        config: {
          ...node.config,
          template_display_name: node.config?.template_display_name || BASE_DISPLAY_NAME,
          delivery_slot: DELIVERY_SLOT,
        },
        outputs: { ...outputs, on_success: joinId, on_fail: originalFail },
        position: { x: baseX + 320, y: baseY + 180 },
      };
    }
    if (descendants.has(nodeId) && node?.position) {
      return {
        ...node,
        outputs,
        position: {
          ...node.position,
          y: (Number(node.position.y) || 0) + verticalShift,
        },
      };
    }
    return { ...node, outputs };
  });

  const conditionNode = {
    id: conditionId,
    type: 'condition/field_check',
    config: {
      migration_key: MIGRATION_KEY,
      mode: 'simple',
      left_ref: {
        source: 'context',
        node_id: null,
        path: 'clinica.access_guidance_reminder_enabled',
        value_type: 'boolean',
        label: 'Clínica tiene marcado difícil acceso',
      },
      operator: 'equals',
      right_value: true,
    },
    outputs: { on_true: variantId, on_false: baseId },
    position: { x: baseX, y: baseY },
  };

  const variantNode = {
    id: variantId,
    type: 'action/send_whatsapp',
    config: {
      ...baseNode.config,
      template_id: '',
      template_name: VARIANT_TEMPLATE_NAME,
      template_display_name: VARIANT_DISPLAY_NAME,
      catalog_template_id: variantCatalogId,
      require_current_catalog_body: true,
      variables: {
        1: '{{paciente.nombre}}',
        2: '{{cita.hora}}',
        3: '{{clinica.direccion}}',
        4: '{{clinica.url_como_llegar}}',
        5: '{{clinica.indicaciones_acceso}}',
      },
      variables_named: VARIANT_VARIABLES_NAMED,
      fallback_template_id: baseNode.config?.template_id || '',
      fallback_template_name: baseNode.config?.template_name || BASE_TEMPLATE_NAME,
      fallback_template_display_name: baseNode.config?.template_display_name || BASE_DISPLAY_NAME,
      fallback_catalog_template_id: baseNode.config?.catalog_template_id || baseCatalogId || null,
      fallback_require_current_catalog_body: false,
      fallback_variables: baseNode.config?.variables || {},
      fallback_variables_named: baseNode.config?.variables_named || {},
      delivery_slot: DELIVERY_SLOT,
      access_guidance_delivery: {
        enabled: true,
        role: 'variant',
        fallback_on_unavailable: true,
        appointment_types: ['primera_sin_trat', 'primera_con_trat'],
      },
    },
    outputs: { on_success: joinId, on_fail: originalFail },
    position: { x: baseX - 320, y: baseY + 180 },
  };

  const joinNode = {
    id: joinId,
    type: 'control/join',
    config: { mode: 'any', migration_key: MIGRATION_KEY },
    outputs: { on_joined: originalSuccess },
    position: { x: baseX, y: baseY + 360 },
  };

  const baseIndex = rewired.findIndex((node) => cleanString(node?.id) === baseId);
  rewired.splice(baseIndex, 0, conditionNode);
  rewired.splice(baseIndex + 2, 0, variantNode, joinNode);
  return rewired;
}

function catalogDefinitionMatches(row) {
  if (!row) return false;
  const variables = parseJson(row.variables, []);
  const components = parseJson(row.components, []);
  return cleanString(row.body_text) === TEMPLATE_BODY
    && jsonEquivalent(variables, TEMPLATE_VARIABLES)
    && jsonEquivalent(components, TEMPLATE_COMPONENTS);
}

async function ensureCatalogTemplate(queryInterface, now, transaction) {
  const rows = await queryInterface.sequelize.query(
    'SELECT id, body_text, variables, components FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1 FOR UPDATE',
    {
      replacements: { name: VARIANT_TEMPLATE_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
  if (rows[0]) {
    if (!catalogDefinitionMatches(rows[0])) {
      throw new Error('access_guidance_catalog_template_definition_mismatch');
    }
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      { is_active: true, updated_at: now },
      { id: rows[0].id },
      { transaction }
    );
    return Number(rows[0].id);
  }

  const tableDefinition = await queryInterface.describeTable('WhatsappTemplateCatalog');
  const payload = pickExistingColumns({
    name: VARIANT_TEMPLATE_NAME,
    display_name: VARIANT_DISPLAY_NAME,
    category: 'UTILITY',
    body_text: TEMPLATE_BODY,
    variables: JSON.stringify(TEMPLATE_VARIABLES),
    components: JSON.stringify(TEMPLATE_COMPONENTS),
    is_generic: true,
    is_active: true,
    propagation_state: null,
    created_at: now,
    updated_at: now,
  }, tableDefinition);
  await queryInterface.bulkInsert('WhatsappTemplateCatalog', [payload], { transaction });
  const inserted = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name: VARIANT_TEMPLATE_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
  if (!inserted[0]?.id) throw new Error('access_guidance_catalog_template_insert_failed');
  return Number(inserted[0].id);
}

async function loadFlowFamilies(queryInterface, transaction) {
  return queryInterface.sequelize.query(
    `
      SELECT id, public_id, template_key, version, engine_version, name, description,
             trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
             entry_node_id, nodes, published_at, published_by, created_by
      FROM AutomationFlowTemplatesV2
      WHERE trigger_type = :triggerType
      ORDER BY public_id ASC, version ASC
      FOR UPDATE
    `,
    {
      replacements: { triggerType: TRIGGER_TYPE },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
}

async function publishCanonicalVersions(queryInterface, variantCatalogId, now, transaction) {
  const baseCatalogRows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name: BASE_TEMPLATE_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
      transaction,
    }
  );
  const baseCatalogId = Number(baseCatalogRows[0]?.id) || null;
  const rows = await loadFlowFamilies(queryInterface, transaction);
  const tableDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const families = new Map();
  rows.forEach((row) => {
    const key = cleanString(row.public_id) || `template:${cleanString(row.template_key)}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(row);
  });

  const published = [];
  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const latestPublished = publishedRows[publishedRows.length - 1] || null;
    const canonical = [...publishedRows]
      .reverse()
      .find((row) => hasCanonicalBranch(parseJson(row.nodes, [])));
    if (canonical) {
      if (Number(latestPublished?.version) > Number(canonical.version)) continue;
      for (const row of publishedRows) {
        if (Number(row.id) === Number(canonical.id) || Number(row.is_active) !== 1) continue;
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { is_active: false, updated_at: now },
          { id: row.id },
          { transaction }
        );
      }
      if (Number(canonical.is_active) !== 1) {
        await queryInterface.bulkUpdate(
          'AutomationFlowTemplatesV2',
          { is_active: true, updated_at: now },
          { id: canonical.id },
          { transaction }
        );
      }
      published.push({ public_id: canonical.public_id, template_key: canonical.template_key, version: Number(canonical.version) });
      continue;
    }

    const active = [...familyRows]
      .reverse()
      .find((row) => Number(row.is_active) === 1 && row.published_at);
    if (!active) continue;
    const activeNodes = parseJson(active.nodes, []);
    if (!isSameDayEightReminder(active, activeNodes)) continue;
    if (!activeNodes.some((node) => isBaseReminderNode(node, baseCatalogId))) continue;

    const nextVersion = Math.max(...familyRows.map((row) => Number(row.version) || 0)) + 1;
    const nextNodes = buildExplicitBranchNodes(activeNodes, baseCatalogId, variantCatalogId);
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
      nodes: JSON.stringify(nextNodes),
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
    published.push({ public_id: active.public_id, template_key: active.template_key, version: nextVersion });
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

async function rollbackCanonicalVersions(queryInterface, now, transaction) {
  const rows = await loadFlowFamilies(queryInterface, transaction);
  const families = new Map();
  rows.forEach((row) => {
    const key = cleanString(row.public_id) || `template:${cleanString(row.template_key)}`;
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(row);
  });

  const restored = [];
  for (const familyRows of families.values()) {
    const publishedRows = familyRows.filter((row) => row.published_at);
    const canonicalRows = publishedRows
      .filter((row) => hasCanonicalBranch(parseJson(row.nodes, [])));
    const firstCanonical = canonicalRows[0] || null;
    if (!firstCanonical) continue;
    const activePublished = [...publishedRows]
      .reverse()
      .find((row) => Number(row.is_active) === 1);
    const hasNewerNonCanonicalActive = activePublished
      && Number(activePublished.version) > Number(firstCanonical.version)
      && !hasCanonicalBranch(parseJson(activePublished.nodes, []));
    for (const canonical of canonicalRows) {
      if (Number(canonical.is_active) !== 1) continue;
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: false, updated_at: now },
        { id: canonical.id },
        { transaction }
      );
    }
    if (hasNewerNonCanonicalActive) continue;
    const predecessor = [...publishedRows]
      .reverse()
      .find((row) => Number(row.version) < Number(firstCanonical.version));
    if (!predecessor) continue;
    if (Number(predecessor.is_active) !== 1) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { is_active: true, updated_at: now },
        { id: predecessor.id },
        { transaction }
      );
    }
    restored.push({ public_id: firstCanonical.public_id, version: Number(predecessor.version) });
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
      const now = new Date();
      const variantCatalogId = await ensureCatalogTemplate(queryInterface, now, transaction);
      await publishCanonicalVersions(queryInterface, variantCatalogId, now, transaction);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const now = new Date();
      await rollbackCanonicalVersions(queryInterface, now, transaction);
      const rows = await queryInterface.sequelize.query(
        'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1 FOR UPDATE',
        {
          replacements: { name: VARIANT_TEMPLATE_NAME },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        }
      );
      if (rows[0]?.id) {
        await queryInterface.bulkUpdate(
          'WhatsappTemplateCatalog',
          { is_active: false, updated_at: now },
          { id: rows[0].id },
          { transaction }
        );
      }
    });
  },

  __test: {
    buildExplicitBranchNodes,
    catalogDefinitionMatches,
    hasCanonicalBranch,
    isSameDayEightReminder,
  },
};
