'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const UsuarioClinica = db.UsuarioClinica;
const Clinica = db.Clinica;
const jobRequestsService = require('../services/jobRequests.service');

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => Number.parseInt(String(v).trim(), 10))
  .filter((n) => Number.isInteger(n));

const MANAGER_ROLES = new Set(['propietario', 'personaldeclinica', 'administrador', 'admin']);

function parseIntOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const normalized = typeof raw === 'string' && raw.includes(',') ? raw.split(',')[0].trim() : raw;
  const parsed = Number.parseInt(String(normalized), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseBool(raw, fallback = undefined) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseLimit(raw, fallback = 20) {
  const parsed = parseIntOrNull(raw);
  if (!parsed || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function parseOffset(raw) {
  const parsed = parseIntOrNull(raw);
  if (!parsed || parsed < 0) return 0;
  return parsed;
}

function cleanString(raw) {
  if (raw === undefined || raw === null) return null;
  const out = String(raw).trim();
  return out || null;
}

function sanitizeTemplateKey(raw) {
  const base = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || null;
}

function buildTemplateKey({ templateKey, name }) {
  const explicit = sanitizeTemplateKey(templateKey);
  if (explicit) return explicit;
  const fromName = sanitizeTemplateKey(name);
  if (fromName) return fromName;
  return `flow_${Date.now()}`;
}

function isAdmin(req) {
  const uid = Number(req.userData?.userId);
  return Number.isInteger(uid) && ADMIN_USER_IDS.includes(uid);
}

async function resolveAccess(req) {
  const userId = Number(req.userData?.userId);
  if (!Number.isInteger(userId)) {
    return { user_id: null, is_admin: false, clinic_ids: new Set(), group_ids: new Set() };
  }

  if (isAdmin(req)) {
    return { user_id: userId, is_admin: true, clinic_ids: new Set(), group_ids: new Set() };
  }

  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });

  const managedClinicIds = memberships
    .filter((m) => MANAGER_ROLES.has(String(m.rol_clinica || '').toLowerCase()))
    .map((m) => Number(m.id_clinica))
    .filter((n) => Number.isInteger(n));

  const clinicIds = new Set(managedClinicIds);
  let groupIds = new Set();

  if (managedClinicIds.length) {
    const clinics = await Clinica.findAll({
      where: { id_clinica: { [Op.in]: managedClinicIds } },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
    });

    groupIds = new Set(
      clinics
        .map((c) => Number(c.grupoClinicaId))
        .filter((n) => Number.isInteger(n) && n > 0)
    );
  }

  return { user_id: userId, is_admin: false, clinic_ids: clinicIds, group_ids: groupIds };
}

function hasScopeAccess(access, { clinic_id, group_id, is_system }) {
  if (access.is_admin) return true;
  if (is_system) return true;

  const clinicId = parseIntOrNull(clinic_id);
  const groupId = parseIntOrNull(group_id);

  if (clinicId && access.clinic_ids.has(clinicId)) return true;
  if (groupId && access.group_ids.has(groupId)) return true;
  return false;
}

function assertCreateScopeAllowed(access, { clinic_id, group_id, is_system }) {
  if (access.is_admin) return true;
  if (is_system) return false;

  const clinicId = parseIntOrNull(clinic_id);
  const groupId = parseIntOrNull(group_id);

  if (!clinicId && !groupId) return false;
  if (clinicId && !access.clinic_ids.has(clinicId)) return false;
  if (groupId && !access.group_ids.has(groupId)) return false;
  return true;
}

function mapTemplate(row, { includeNodes = true } = {}) {
  const item = row?.toJSON ? row.toJSON() : row;
  const base = {
    id: item.id,
    template_key: item.template_key,
    version: item.version,
    engine_version: item.engine_version,
    name: item.name,
    description: item.description ?? null,
    trigger_type: item.trigger_type,
    is_active: item.is_active !== false,
    is_system: !!item.is_system,
    clinic_id: item.clinic_id ?? null,
    group_id: item.group_id ?? null,
    entry_node_id: item.entry_node_id,
    published_at: item.published_at ?? null,
    published_by: item.published_by ?? null,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  if (includeNodes) {
    base.nodes = Array.isArray(item.nodes) ? item.nodes : [];
  }

  return base;
}

function mapExecution(row, { includeContext = true } = {}) {
  const item = row?.toJSON ? row.toJSON() : row;
  const base = {
    id: item.id,
    idempotency_key: item.idempotency_key,
    template_version_id: item.template_version_id,
    engine_version: item.engine_version,
    status: item.status,
    current_node_id: item.current_node_id ?? null,
    trigger_type: item.trigger_type,
    trigger_entity_type: item.trigger_entity_type ?? null,
    trigger_entity_id: item.trigger_entity_id ?? null,
    clinic_id: item.clinic_id ?? null,
    group_id: item.group_id ?? null,
    wait_until: item.wait_until ?? null,
    waiting_meta: item.waiting_meta ?? null,
    last_error: item.last_error ?? null,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  if (includeContext) {
    base.context = item.context ?? {};
  }

  if (item.templateVersion) {
    const t = item.templateVersion;
    base.template = {
      id: t.id,
      template_key: t.template_key,
      version: t.version,
      name: t.name,
      trigger_type: t.trigger_type,
    };
  }

  return base;
}

function buildIdempotencyKey({ trigger_type, trigger_entity_id, template_version_id, window_identifier }) {
  const parts = [
    cleanString(trigger_type) || 'manual',
    cleanString(trigger_entity_id) || '0',
    cleanString(template_version_id) || '0',
  ];
  const windowId = cleanString(window_identifier);
  if (windowId) parts.push(windowId);
  return parts.join(':');
}

function buildValidationError(code, message, details = null) {
  return { code, message, details };
}

function validateFlowGraph({ entry_node_id, nodes }) {
  const errors = [];

  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push(buildValidationError('nodes_required', 'El flujo debe tener al menos un nodo'));
    return { ok: false, errors };
  }

  const nodeMap = new Map();
  const indegree = new Map();
  const adjacency = new Map();

  for (const node of nodes) {
    const nodeId = cleanString(node?.id);
    if (!nodeId) {
      errors.push(buildValidationError('node_id_missing', 'Hay nodos sin id'));
      continue;
    }
    if (!/^N[0-9]+$/.test(nodeId)) {
      errors.push(buildValidationError('node_id_invalid', `El nodo ${nodeId} no cumple el patrón ^N[0-9]+$`));
    }
    if (nodeMap.has(nodeId)) {
      errors.push(buildValidationError('node_id_duplicated', `El nodo ${nodeId} está duplicado`));
      continue;
    }
    nodeMap.set(nodeId, node);
    indegree.set(nodeId, 0);
    adjacency.set(nodeId, []);
  }

  const entryNodeId = cleanString(entry_node_id);
  if (!entryNodeId || !nodeMap.has(entryNodeId)) {
    errors.push(buildValidationError('entry_node_invalid', 'entry_node_id no existe en nodes'));
  }

  for (const [nodeId, node] of nodeMap.entries()) {
    const outputs = node?.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
      errors.push(buildValidationError('outputs_invalid', `El nodo ${nodeId} debe definir outputs como objeto`));
      continue;
    }

    for (const [outputKey, target] of Object.entries(outputs)) {
      if (target === null || target === undefined || target === '') continue;
      const targetId = cleanString(target);
      if (!targetId) continue;
      if (!nodeMap.has(targetId)) {
        errors.push(buildValidationError('output_target_missing', `El nodo ${nodeId} apunta a ${targetId} en '${outputKey}', pero no existe`));
        continue;
      }
      adjacency.get(nodeId).push(targetId);
      indegree.set(targetId, (indegree.get(targetId) || 0) + 1);
    }
  }

  for (const [nodeId, degree] of indegree.entries()) {
    if (nodeId !== entryNodeId && degree === 0) {
      errors.push(buildValidationError('node_orphan', `El nodo ${nodeId} no tiene conexiones de entrada`));
    }
  }

  if (entryNodeId && nodeMap.has(entryNodeId)) {
    const visited = new Set();
    const queue = [entryNodeId];
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) queue.push(next);
      }
    }

    const unreachable = Array.from(nodeMap.keys()).filter((id) => !visited.has(id));
    if (unreachable.length) {
      errors.push(buildValidationError('unreachable_nodes', 'Existen nodos inalcanzables desde entry_node_id', { nodes: unreachable }));
    }

    // Detección de ciclos (no permitidos en v1.1 inicial)
    const colors = new Map(); // 0 unvisited, 1 visiting, 2 done
    const cyclePath = [];
    let cycleDetected = false;

    function dfs(nodeId) {
      if (cycleDetected) return;
      colors.set(nodeId, 1);
      cyclePath.push(nodeId);

      for (const next of adjacency.get(nodeId) || []) {
        const color = colors.get(next) || 0;
        if (color === 0) {
          dfs(next);
          if (cycleDetected) return;
        } else if (color === 1) {
          cycleDetected = true;
          const start = cyclePath.indexOf(next);
          const cycleNodes = start >= 0 ? cyclePath.slice(start).concat(next) : [next];
          errors.push(buildValidationError('cycle_detected', 'Se detectó un ciclo en el grafo', { cycle: cycleNodes }));
          return;
        }
      }

      cyclePath.pop();
      colors.set(nodeId, 2);
    }

    for (const nodeId of nodeMap.keys()) {
      if ((colors.get(nodeId) || 0) === 0) {
        dfs(nodeId);
      }
      if (cycleDetected) break;
    }
  }

  return { ok: errors.length === 0, errors };
}

exports.listTemplates = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.is_admin && access.clinic_ids.size === 0 && access.group_ids.size === 0) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const limit = parseLimit(req.query?.limit, 20);
    const offset = parseOffset(req.query?.offset);
    const includeNodes = parseBool(req.query?.include_nodes, false);

    const where = {};

    const triggerType = cleanString(req.query?.trigger_type);
    if (triggerType) where.trigger_type = triggerType;

    const engineVersion = cleanString(req.query?.engine_version);
    if (engineVersion) where.engine_version = engineVersion;

    const isSystem = parseBool(req.query?.is_system, undefined);
    if (isSystem !== undefined) where.is_system = isSystem;

    const isActive = parseBool(req.query?.is_active, undefined);
    if (isActive !== undefined) where.is_active = isActive;

    const search = cleanString(req.query?.search);
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { template_key: { [Op.like]: `%${search}%` } },
      ];
    }

    const clinicId = parseIntOrNull(req.query?.clinic_id);
    const groupId = parseIntOrNull(req.query?.group_id);

    if (clinicId) {
      if (!access.is_admin && !access.clinic_ids.has(clinicId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      where.clinic_id = clinicId;
    }

    if (groupId) {
      if (!access.is_admin && !access.group_ids.has(groupId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      where.group_id = groupId;
    }

    if (!access.is_admin && !clinicId && !groupId) {
      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({
        [Op.or]: [
          { is_system: true },
          { clinic_id: { [Op.in]: Array.from(access.clinic_ids) } },
          ...(access.group_ids.size ? [{ group_id: { [Op.in]: Array.from(access.group_ids) } }] : []),
        ],
      });
    }

    const { count, rows } = await AutomationFlowTemplateV2.findAndCountAll({
      where,
      limit,
      offset,
      order: [['template_key', 'ASC'], ['version', 'DESC']],
    });

    return res.json({
      success: true,
      data: rows.map((row) => mapTemplate(row, { includeNodes })),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listTemplates v2', err);
    return res.status(500).json({ success: false, error: 'list_failed', message: err.message });
  }
};

exports.createTemplateDraft = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.user_id) {
      return res.status(401).json({ success: false, error: 'auth_required' });
    }

    const body = req.body || {};
    const name = cleanString(body.name);
    const triggerType = cleanString(body.trigger_type);
    const entryNodeId = cleanString(body.entry_node_id);
    const nodes = Array.isArray(body.nodes) ? body.nodes : null;

    if (!name || !triggerType || !entryNodeId || !nodes) {
      return res.status(400).json({
        success: false,
        error: 'invalid_payload',
        message: 'name, trigger_type, entry_node_id y nodes son obligatorios',
      });
    }

    const templateKey = buildTemplateKey({ templateKey: body.template_key, name });
    const clinicId = parseIntOrNull(body.clinic_id);
    const groupId = parseIntOrNull(body.group_id);
    const isSystem = access.is_admin ? parseBool(body.is_system, false) : false;

    if (!assertCreateScopeAllowed(access, { clinic_id: clinicId, group_id: groupId, is_system: isSystem })) {
      return res.status(403).json({ success: false, error: 'forbidden_scope' });
    }

    const existingDraft = await AutomationFlowTemplateV2.findOne({
      where: {
        template_key: templateKey,
        published_at: null,
      },
      order: [['version', 'DESC']],
    });

    if (existingDraft) {
      return res.status(409).json({
        success: false,
        error: 'draft_already_exists',
        message: `Ya existe un borrador para template_key '${templateKey}' (versión ${existingDraft.version})`,
      });
    }

    const latest = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey },
      attributes: ['version'],
      order: [['version', 'DESC']],
      raw: true,
    });

    const version = latest?.version ? Number(latest.version) + 1 : 1;

    const created = await AutomationFlowTemplateV2.create({
      template_key: templateKey,
      version,
      engine_version: cleanString(body.engine_version) || 'v2',
      name,
      description: cleanString(body.description),
      trigger_type: triggerType,
      is_active: parseBool(body.is_active, true),
      is_system: !!isSystem,
      clinic_id: clinicId,
      group_id: groupId,
      entry_node_id: entryNodeId,
      nodes,
      published_at: null,
      published_by: null,
      created_by: access.user_id,
    });

    return res.status(201).json({ success: true, data: mapTemplate(created, { includeNodes: true }) });
  } catch (err) {
    console.error('Error createTemplateDraft v2', err);
    return res.status(500).json({ success: false, error: 'create_failed', message: err.message });
  }
};

exports.getTemplateLatestPublished = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);

    if (!templateKey) {
      return res.status(400).json({ success: false, error: 'invalid_template_key' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: {
        template_key: templateKey,
        published_at: { [Op.ne]: null },
        is_active: true,
      },
      order: [['version', 'DESC']],
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_not_found' });
    }

    return res.json({ success: true, data: mapTemplate(row, { includeNodes: true }) });
  } catch (err) {
    console.error('Error getTemplateLatestPublished v2', err);
    return res.status(500).json({ success: false, error: 'get_failed', message: err.message });
  }
};

exports.listTemplateVersions = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    if (!templateKey) {
      return res.status(400).json({ success: false, error: 'invalid_template_key' });
    }

    const limit = parseLimit(req.query?.limit, 20);
    const offset = parseOffset(req.query?.offset);
    const includeNodes = parseBool(req.query?.include_nodes, false);

    const { count, rows } = await AutomationFlowTemplateV2.findAndCountAll({
      where: { template_key: templateKey },
      limit,
      offset,
      order: [['version', 'DESC']],
    });

    const visible = rows.filter((row) => hasScopeAccess(access, row));

    return res.json({
      success: true,
      data: visible.map((row) => mapTemplate(row, { includeNodes })),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listTemplateVersions v2', err);
    return res.status(500).json({ success: false, error: 'list_versions_failed', message: err.message });
  }
};

exports.getTemplateVersion = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    return res.json({ success: true, data: mapTemplate(row, { includeNodes: true }) });
  } catch (err) {
    console.error('Error getTemplateVersion v2', err);
    return res.status(500).json({ success: false, error: 'get_version_failed', message: err.message });
  }
};

exports.updateTemplateDraft = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    if (row.published_at) {
      return res.status(409).json({
        success: false,
        error: 'published_immutable',
        message: 'No se puede editar una versión publicada. Crea un nuevo draft.',
      });
    }

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const name = cleanString(body.name);
      if (!name) return res.status(400).json({ success: false, error: 'invalid_name' });
      updates.name = name;
    }
    if (body.description !== undefined) updates.description = cleanString(body.description);
    if (body.trigger_type !== undefined) {
      const triggerType = cleanString(body.trigger_type);
      if (!triggerType) return res.status(400).json({ success: false, error: 'invalid_trigger_type' });
      updates.trigger_type = triggerType;
    }
    if (body.entry_node_id !== undefined) {
      const entry = cleanString(body.entry_node_id);
      if (!entry) return res.status(400).json({ success: false, error: 'invalid_entry_node' });
      updates.entry_node_id = entry;
    }
    if (body.nodes !== undefined) {
      if (!Array.isArray(body.nodes)) return res.status(400).json({ success: false, error: 'invalid_nodes' });
      updates.nodes = body.nodes;
    }
    if (body.is_active !== undefined) updates.is_active = parseBool(body.is_active, row.is_active);
    if (access.is_admin && body.is_system !== undefined) updates.is_system = parseBool(body.is_system, row.is_system);

    await row.update(updates);

    return res.json({ success: true, data: mapTemplate(row, { includeNodes: true }) });
  } catch (err) {
    console.error('Error updateTemplateDraft v2', err);
    return res.status(500).json({ success: false, error: 'update_failed', message: err.message });
  }
};

exports.publishTemplateVersion = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    if (row.published_at) {
      return res.status(409).json({ success: false, error: 'already_published' });
    }

    const validation = validateFlowGraph({
      entry_node_id: row.entry_node_id,
      nodes: Array.isArray(row.nodes) ? row.nodes : [],
    });

    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        error: 'graph_validation_failed',
        validation_errors: validation.errors,
      });
    }

    await row.update({
      published_at: new Date(),
      published_by: access.user_id,
    });

    return res.json({ success: true, data: mapTemplate(row, { includeNodes: true }) });
  } catch (err) {
    console.error('Error publishTemplateVersion v2', err);
    return res.status(500).json({ success: false, error: 'publish_failed', message: err.message });
  }
};

exports.executeTemplateVersion = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    if (!row.published_at) {
      return res.status(409).json({ success: false, error: 'draft_not_executable' });
    }

    const body = req.body || {};
    const triggerEntityId = parseIntOrNull(body.trigger_entity_id);
    const triggerEntityType = cleanString(body.trigger_entity_type) || 'entity';

    const idempotencyKey = cleanString(body.idempotency_key) || buildIdempotencyKey({
      trigger_type: row.trigger_type,
      trigger_entity_id: triggerEntityId || 0,
      template_version_id: row.id,
      window_identifier: body.window_identifier,
    });

    const existing = await FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
    if (existing) {
      return res.status(200).json({
        success: true,
        deduplicated: true,
        data: existing,
      });
    }

    const initialContext = body.initial_context && typeof body.initial_context === 'object' && !Array.isArray(body.initial_context)
      ? body.initial_context
      : {};

    const context = {
      trigger: {
        type: row.trigger_type,
        data: body.trigger_data && typeof body.trigger_data === 'object' ? body.trigger_data : {},
      },
      outputs: {},
      ...initialContext,
    };

    const createdExecution = await FlowExecutionV2.create({
      idempotency_key: idempotencyKey,
      template_version_id: row.id,
      engine_version: row.engine_version || 'v2',
      status: 'running',
      context,
      current_node_id: row.entry_node_id,
      trigger_type: row.trigger_type,
      trigger_entity_type: triggerEntityType,
      trigger_entity_id: triggerEntityId,
      clinic_id: row.clinic_id || null,
      group_id: row.group_id || null,
      created_by: access.user_id,
    });

    const requestedByName = cleanString(
      req.userData?.name
      || req.userData?.nombre
      || req.userData?.username
      || req.userData?.email
      || null
    );

    const queueJob = await jobRequestsService.enqueueJobRequest({
      type: 'automations_v2_execute',
      priority: 'high',
      origin: 'automations_v2',
      payload: {
        execution_id: createdExecution.id,
      },
      requestedBy: access.user_id,
      requestedByName,
      requestedByRole: cleanString(req.userData?.role || req.userData?.rol || 'admin'),
    });

    return res.status(202).json({
      success: true,
      deduplicated: false,
      data: mapExecution(createdExecution, { includeContext: true }),
      queue: {
        enqueued: true,
        job_request_id: queueJob.id,
        status: queueJob.status,
      },
    });
  } catch (err) {
    console.error('Error executeTemplateVersion v2', err);
    return res.status(500).json({ success: false, error: 'execute_failed', message: err.message });
  }
};

exports.resumeExecution = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const executionId = parseIntOrNull(req.params?.id);
    if (!executionId) {
      return res.status(400).json({ success: false, error: 'invalid_execution_id' });
    }

    const execution = await FlowExecutionV2.findByPk(executionId);
    if (!execution || !hasScopeAccess(access, execution)) {
      return res.status(404).json({ success: false, error: 'execution_not_found' });
    }

    if (execution.status !== 'waiting') {
      return res.status(409).json({
        success: false,
        error: 'execution_not_waiting',
        message: `La ejecución ${execution.id} no está en espera (status=${execution.status})`,
      });
    }

    const mode = cleanString(req.body?.mode) || 'timeout';
    if (!['timeout', 'response'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_resume_mode',
        message: "mode debe ser 'timeout' o 'response'",
      });
    }

    const requestedByName = cleanString(
      req.userData?.name
      || req.userData?.nombre
      || req.userData?.username
      || req.userData?.email
      || null
    );

    const queueJob = await jobRequestsService.enqueueJobRequest({
      type: 'automations_v2_execute',
      priority: 'high',
      origin: 'automations_v2_resume',
      payload: {
        execution_id: execution.id,
        resume_mode: mode,
        response_text: req.body?.response_text ?? null,
      },
      requestedBy: access.user_id,
      requestedByName,
      requestedByRole: cleanString(req.userData?.role || req.userData?.rol || 'admin'),
    });

    return res.status(202).json({
      success: true,
      data: mapExecution(execution, { includeContext: true }),
      queue: {
        enqueued: true,
        job_request_id: queueJob.id,
        status: queueJob.status,
      },
    });
  } catch (err) {
    console.error('Error resumeExecution v2', err);
    return res.status(500).json({ success: false, error: 'resume_failed', message: err.message });
  }
};

exports.listExecutions = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.is_admin && access.clinic_ids.size === 0 && access.group_ids.size === 0) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const limit = parseLimit(req.query?.limit, 25);
    const offset = parseOffset(req.query?.offset);
    const includeContext = parseBool(req.query?.include_context, false);

    const where = {};
    const status = cleanString(req.query?.status);
    if (status) where.status = status;

    const triggerType = cleanString(req.query?.trigger_type);
    if (triggerType) where.trigger_type = triggerType;

    const triggerEntityId = parseIntOrNull(req.query?.trigger_entity_id);
    if (triggerEntityId) where.trigger_entity_id = triggerEntityId;

    const clinicId = parseIntOrNull(req.query?.clinic_id);
    if (clinicId) {
      if (!access.is_admin && !access.clinic_ids.has(clinicId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      where.clinic_id = clinicId;
    }

    const groupId = parseIntOrNull(req.query?.group_id);
    if (groupId) {
      if (!access.is_admin && !access.group_ids.has(groupId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      where.group_id = groupId;
    }

    if (!access.is_admin && !clinicId && !groupId) {
      const scopeFilters = [];
      if (access.clinic_ids.size) {
        scopeFilters.push({ clinic_id: { [Op.in]: Array.from(access.clinic_ids) } });
      }
      if (access.group_ids.size) {
        scopeFilters.push({ group_id: { [Op.in]: Array.from(access.group_ids) } });
      }
      scopeFilters.push({ created_by: access.user_id });

      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({ [Op.or]: scopeFilters });
    }

    const templateKey = sanitizeTemplateKey(req.query?.template_key);
    const templateWhere = {};
    if (templateKey) templateWhere.template_key = templateKey;

    const { count, rows } = await FlowExecutionV2.findAndCountAll({
      where,
      include: [{
        model: AutomationFlowTemplateV2,
        as: 'templateVersion',
        attributes: ['id', 'template_key', 'version', 'name', 'trigger_type'],
        required: !!templateKey,
        ...(templateKey ? { where: templateWhere } : {}),
      }],
      order: [['id', 'DESC']],
      limit,
      offset,
    });

    return res.json({
      success: true,
      data: rows.map((row) => mapExecution(row, { includeContext })),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listExecutions v2', err);
    return res.status(500).json({ success: false, error: 'list_executions_failed', message: err.message });
  }
};

exports.getExecution = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const executionId = parseIntOrNull(req.params?.id);
    if (!executionId) {
      return res.status(400).json({ success: false, error: 'invalid_execution_id' });
    }

    const execution = await FlowExecutionV2.findByPk(executionId, {
      include: [{
        model: AutomationFlowTemplateV2,
        as: 'templateVersion',
        attributes: ['id', 'template_key', 'version', 'name', 'trigger_type'],
      }],
    });

    if (!execution || !hasScopeAccess(access, execution)) {
      return res.status(404).json({ success: false, error: 'execution_not_found' });
    }

    return res.json({ success: true, data: execution });
  } catch (err) {
    console.error('Error getExecution v2', err);
    return res.status(500).json({ success: false, error: 'get_execution_failed', message: err.message });
  }
};

exports.getExecutionLogs = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const executionId = parseIntOrNull(req.params?.id);
    if (!executionId) {
      return res.status(400).json({ success: false, error: 'invalid_execution_id' });
    }

    const execution = await FlowExecutionV2.findByPk(executionId);
    if (!execution || !hasScopeAccess(access, execution)) {
      return res.status(404).json({ success: false, error: 'execution_not_found' });
    }

    const limit = parseLimit(req.query?.limit, 100);
    const offset = parseOffset(req.query?.offset);

    const { count, rows } = await FlowExecutionLogV2.findAndCountAll({
      where: { flow_execution_id: executionId },
      limit,
      offset,
      order: [['id', 'ASC']],
    });

    return res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error getExecutionLogs v2', err);
    return res.status(500).json({ success: false, error: 'get_execution_logs_failed', message: err.message });
  }
};
