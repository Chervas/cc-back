'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const automationDefaultsService = require('../services/automationDefaults.service');
const {
  AutomationFlowCatalog,
  AutomationFlowCatalogDiscipline,
  AutomationFlowTemplateV2,
} = db;

const CATALOG_TRIGGER_TYPES = [
  'lead_nuevo',
  'appointment_created',
  'appointment_confirmed',
  'appointment_no_show',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_completed',
  'appointment_reminder_window',
  'appointment_after',
  'patient_inactive',
  'quote_accepted',
  'treatment_completed',
  'birthday',
];

const CATALOG_TRIGGER_TYPE_SET = new Set(CATALOG_TRIGGER_TYPES);

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1,44')
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((n) => !Number.isNaN(n));

function cleanString(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function parseIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function sanitizeTemplateKey(raw) {
  const base = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || null;
}

function sanitizeTemplateReference(raw) {
  const base = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || null;
}

function buildDuplicateDisplayName(baseDisplayName, duplicateIndex) {
  const base = String(baseDisplayName || '').trim();
  if (!base) return duplicateIndex > 1 ? `Copia ${duplicateIndex}` : 'Copia';
  return duplicateIndex > 1 ? `${base} (copia ${duplicateIndex})` : `${base} (copia)`;
}

function buildDuplicateCatalogName(baseName, duplicateIndex) {
  const normalized = String(baseName || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase = normalized || 'automatizacion';
  return duplicateIndex > 1 ? `${safeBase}_copy_${duplicateIndex}` : `${safeBase}_copy`;
}

function buildTemplatePublicId() {
  return `flw_${crypto.randomBytes(8).toString('hex')}`;
}

async function generateUniqueTemplatePublicId() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = buildTemplatePublicId();
    const existing = await AutomationFlowTemplateV2.findOne({
      where: { public_id: candidate },
      attributes: ['id'],
      raw: true,
    });
    if (!existing) return candidate;
  }
  throw new Error('template_public_id_generation_failed');
}

async function ensureUniqueAutomationTemplateKey(baseKey) {
  const normalizedBase = sanitizeTemplateKey(baseKey) || `flow_${Date.now()}`;
  let candidate = normalizedBase.slice(0, 120);
  let duplicateIndex = 1;

  // AutomationFlowTemplatesV2 versions share template_key, so a duplicate catalog
  // must receive a new family key or "Editar flujo" would edit the source flow.
  while (await AutomationFlowTemplateV2.findOne({ where: { template_key: candidate }, attributes: ['id'], raw: true })) {
    duplicateIndex += 1;
    const suffix = `_copy_${duplicateIndex}`;
    candidate = `${normalizedBase.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
  }

  return candidate;
}

function cloneJson(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

async function resolveAutomationCatalogDuplicateNames(itemId, { baseName, baseDisplayName }) {
  const rows = await AutomationFlowCatalog.findAll({
    attributes: ['id', 'name', 'display_name'],
    raw: true,
  });
  const takenNames = new Set(
    rows
      .filter((row) => Number(row.id) !== Number(itemId))
      .map((row) => String(row.name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const takenDisplayNames = new Set(
    rows
      .filter((row) => Number(row.id) !== Number(itemId))
      .map((row) => String(row.display_name || '').trim().toLowerCase())
      .filter(Boolean)
  );

  let duplicateIndex = 1;
  let nextName = buildDuplicateCatalogName(baseName, duplicateIndex);
  let nextDisplayName = buildDuplicateDisplayName(baseDisplayName || baseName, duplicateIndex);

  while (
    takenNames.has(String(nextName).trim().toLowerCase()) ||
    takenDisplayNames.has(String(nextDisplayName).trim().toLowerCase())
  ) {
    duplicateIndex += 1;
    nextName = buildDuplicateCatalogName(baseName, duplicateIndex);
    nextDisplayName = buildDuplicateDisplayName(baseDisplayName || baseName, duplicateIndex);
  }

  return { name: nextName, display_name: nextDisplayName };
}

async function duplicateLinkedFlowTemplateForCatalog({ sourceTemplate, names, actorUserId }) {
  if (!sourceTemplate) return null;

  const nextTemplateKey = await ensureUniqueAutomationTemplateKey(names.name);
  const nextPublicId = await generateUniqueTemplatePublicId();
  const source = sourceTemplate?.toJSON ? sourceTemplate.toJSON() : sourceTemplate;

  return AutomationFlowTemplateV2.create({
    public_id: nextPublicId,
    template_key: nextTemplateKey,
    version: 1,
    engine_version: source.engine_version || 'v2',
    name: names.display_name || source.name || 'Copia',
    description: source.description || null,
    trigger_type: source.trigger_type,
    trigger_config: cloneJson(source.trigger_config, null),
    is_active: true,
    is_system: !!source.is_system,
    clinic_id: null,
    group_id: null,
    entry_node_id: source.entry_node_id,
    nodes: cloneJson(source.nodes, []),
    published_at: null,
    published_by: null,
    created_by: actorUserId || source.created_by || 1,
  });
}

function assertAdmin(req, res) {
  const uid = Number(req.userData?.userId);
  if (!uid || !ADMIN_USER_IDS.includes(uid)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

function extractDisciplinaCodes(payload) {
  const raw = Array.isArray(payload?.disciplina_codes) ? payload.disciplina_codes : [];
  return raw
    .map((code) => (typeof code === 'string' ? code.trim() : null))
    .filter((code) => !!code);
}

function normalizeCatalogTriggerType(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || null;
}

function mapNodesToCatalogSteps(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  return list.map((node, index) => ({
    id: node?.id || null,
    type: node?.type || 'unknown',
    name: node?.label || node?.id || `Paso ${index + 1}`,
    config: {},
    order: index + 1,
  }));
}

async function resolveLinkedTemplateByKey(templateKey) {
  return resolveLinkedTemplateForCatalog({
    templateKey,
    requirePublishedActive: true,
  });
}

async function resolveCatalogTemplateFamilyWhere(rawReference) {
  const normalizedReference = sanitizeTemplateReference(rawReference);
  if (!normalizedReference) return null;

  const byPublicId = await AutomationFlowTemplateV2.findOne({
    where: { public_id: normalizedReference },
    attributes: ['id'],
    raw: true,
  });
  if (byPublicId) {
    return { public_id: normalizedReference };
  }

  const templateKey = sanitizeTemplateKey(normalizedReference);
  if (!templateKey) return null;
  return { template_key: templateKey };
}

async function resolveLinkedTemplateForCatalog({
  templateKey,
  templateVersion = null,
  requirePublishedActive = false,
}) {
  const familyWhere = await resolveCatalogTemplateFamilyWhere(templateKey);
  if (!familyWhere) return null;

  const version = parseIntOrNull(templateVersion);
  const where = { ...familyWhere };
  if (version) {
    where.version = version;
  }
  if (requirePublishedActive) {
    where.published_at = { [Op.ne]: null };
    where.is_active = true;
  }

  return AutomationFlowTemplateV2.findOne({
    where,
    order: [['version', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
}

async function loadLinkedTemplatesForItems(items) {
  const rows = Array.isArray(items) ? items : [];
  const requests = rows
    .map((item) => {
      const data = item?.toJSON ? item.toJSON() : item;
      const templateKey = typeof data?.template_key === 'string' ? data.template_key.trim() : '';
      if (!templateKey) return null;
      return {
        itemId: Number(data.id),
        templateKey,
        templateVersion: parseIntOrNull(data?.template_version),
      };
    })
    .filter(Boolean);

  const results = await Promise.all(
    requests.map(async (request) => ({
      itemId: request.itemId,
      template: await resolveLinkedTemplateForCatalog({
        templateKey: request.templateKey,
        templateVersion: request.templateVersion,
      }),
    }))
  );

  const mapByItemId = new Map();
  results.forEach(({ itemId, template }) => {
    mapByItemId.set(itemId, template || null);
  });
  return mapByItemId;
}

function serializeCatalogItem(item, linkedTemplate = null) {
  const data = item?.toJSON ? item.toJSON() : item;
  const effectiveTriggerType = linkedTemplate?.trigger_type || data?.trigger_type;
  const effectiveSteps = linkedTemplate
    ? mapNodesToCatalogSteps(linkedTemplate.nodes)
    : (Array.isArray(data?.steps) ? data.steps : []);
  const currentTemplateKey = cleanString(data?.template_key);
  const currentTemplateVersion = parseIntOrNull(data?.template_version);
  const lastPropagatedAt = data?.last_propagated_at ? new Date(data.last_propagated_at) : null;
  const updatedAt = data?.updated_at ? new Date(data.updated_at) : null;
  const propagated =
    !!lastPropagatedAt &&
    !!currentTemplateKey &&
    cleanString(data?.last_propagated_template_key) === currentTemplateKey &&
    parseIntOrNull(data?.last_propagated_template_version) === currentTemplateVersion &&
    (!updatedAt || updatedAt.getTime() <= lastPropagatedAt.getTime());
  return {
    ...data,
    propagated,
    trigger_type: normalizeCatalogTriggerType(effectiveTriggerType),
    steps: effectiveSteps,
    template_key: typeof data?.template_key === 'string' ? data.template_key : null,
    template_version: parseIntOrNull(data?.template_version) || parseIntOrNull(linkedTemplate?.version),
    linked_template: linkedTemplate
      ? {
          template_key: cleanString(linkedTemplate.public_id) || linkedTemplate.template_key,
          template_version: Number(linkedTemplate.version),
          name: linkedTemplate.name,
          trigger_type: linkedTemplate.trigger_type,
          trigger_config: linkedTemplate.trigger_config ?? null,
          node_count: Array.isArray(linkedTemplate.nodes) ? linkedTemplate.nodes.length : 0,
          is_system: !!linkedTemplate.is_system,
          is_active: linkedTemplate.is_active !== false,
          published_at: linkedTemplate.published_at ?? null,
          clinic_id: linkedTemplate.clinic_id ?? null,
          group_id: linkedTemplate.group_id ?? null,
        }
      : null,
  };
}

exports.listCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const items = await AutomationFlowCatalog.findAll({
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
      order: [['display_name', 'ASC']],
    });
    const linkedTemplates = await loadLinkedTemplatesForItems(items);
    return res.json(
      items.map((item) => serializeCatalogItem(item, linkedTemplates.get(Number(item.id)) || null))
    );
  } catch (err) {
    console.error('Error listCatalog', err);
    return res.status(500).json({ error: 'Error obteniendo catálogo' });
  }
};

exports.getCatalogById = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const item = await AutomationFlowCatalog.findByPk(req.params.id, {
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
    });
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }
    const linkedTemplate = await resolveLinkedTemplateForCatalog({
      templateKey: item.template_key,
      templateVersion: item.template_version,
    });
    return res.json(serializeCatalogItem(item, linkedTemplate));
  } catch (err) {
    console.error('Error getCatalogById', err);
    return res.status(500).json({ error: 'Error obteniendo catálogo' });
  }
};

exports.createCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const payload = req.body || {};
    const name = payload.name || payload.internal_name || payload.slug;
    const display_name = payload.display_name || payload.displayName || payload.nombre;
    const description = payload.description || payload.descripcion || null;
    const template_key = typeof payload.template_key === 'string' ? payload.template_key.trim() : null;
    const template_version = parseIntOrNull(payload.template_version);
    const is_generic = typeof payload.is_generic === 'boolean' ? payload.is_generic : !!payload.isGeneric;
    const is_active = typeof payload.is_active === 'boolean' ? payload.is_active : (typeof payload.isActive === 'boolean' ? payload.isActive : true);
    const disciplinaCodes = extractDisciplinaCodes(payload);
    const linkedTemplate = await resolveLinkedTemplateForCatalog({
      templateKey: template_key,
      templateVersion: template_version,
    });

    if (!name || !template_key) {
      return res.status(400).json({ error: 'name y template_key son obligatorios' });
    }
    if (!linkedTemplate) {
      return res.status(404).json({ error: 'linked_template_not_found' });
    }

    const trigger_type = normalizeCatalogTriggerType(linkedTemplate.trigger_type);
    if (!CATALOG_TRIGGER_TYPE_SET.has(trigger_type)) {
      return res.status(400).json({
        error: 'invalid_trigger_type',
        message: `trigger_type no soportado: ${trigger_type}`,
        allowed: CATALOG_TRIGGER_TYPES,
      });
    }
    const steps = mapNodesToCatalogSteps(linkedTemplate.nodes);

    const item = await AutomationFlowCatalog.create({
      name,
      display_name: display_name || null,
      description,
      trigger_type,
      steps,
      template_key,
      template_version: template_version || parseIntOrNull(linkedTemplate?.version),
      is_generic,
      is_active,
    });
    if (!is_generic && disciplinaCodes.length) {
      const rows = disciplinaCodes.map((code) => ({ flow_catalog_id: item.id, disciplina_code: code }));
      await AutomationFlowCatalogDiscipline.bulkCreate(rows);
    }
    const createdItem = await AutomationFlowCatalog.findByPk(item.id, {
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
    });
    return res.status(201).json(serializeCatalogItem(createdItem, linkedTemplate));
  } catch (err) {
    console.error('Error createCatalog', err);
    return res.status(500).json({ error: 'Error creando automatización de catálogo' });
  }
};

exports.updateCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const item = await AutomationFlowCatalog.findByPk(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }

    const payload = req.body || {};
    const name = payload.name || payload.internal_name || payload.slug;
    const display_name = payload.display_name || payload.displayName || payload.nombre;
    const description = payload.description || payload.descripcion;
    const template_key = payload.template_key !== undefined
      ? (typeof payload.template_key === 'string' ? payload.template_key.trim() : null)
      : undefined;
    const template_version = payload.template_version !== undefined
      ? parseIntOrNull(payload.template_version)
      : undefined;
    const is_generic = typeof payload.is_generic === 'boolean' ? payload.is_generic : (typeof payload.isGeneric === 'boolean' ? payload.isGeneric : undefined);
    const is_active = typeof payload.is_active === 'boolean' ? payload.is_active : (typeof payload.isActive === 'boolean' ? payload.isActive : undefined);
    const disciplinaCodes = extractDisciplinaCodes(payload);
    const disciplinesProvided = Object.prototype.hasOwnProperty.call(payload, 'disciplina_codes');
    const effectiveTemplateKey = template_key !== undefined ? template_key : item.template_key;
    const effectiveTemplateVersion = template_version !== undefined ? template_version : item.template_version;
    const linkedTemplate = effectiveTemplateKey
      ? await resolveLinkedTemplateForCatalog({
          templateKey: effectiveTemplateKey,
          templateVersion: effectiveTemplateVersion,
        })
      : null;
    const isUnlinkingFlow = template_key !== undefined && !effectiveTemplateKey;
    const trigger_type = linkedTemplate?.trigger_type ? normalizeCatalogTriggerType(linkedTemplate.trigger_type) : item.trigger_type;
    const steps = linkedTemplate ? mapNodesToCatalogSteps(linkedTemplate.nodes) : item.steps;

    if (effectiveTemplateKey && !linkedTemplate) {
      return res.status(404).json({ error: 'linked_template_not_found' });
    }
    if (!isUnlinkingFlow && !CATALOG_TRIGGER_TYPE_SET.has(trigger_type)) {
      return res.status(400).json({
        error: 'invalid_trigger_type',
        message: `trigger_type no soportado: ${String(trigger_type)}`,
        allowed: CATALOG_TRIGGER_TYPES,
      });
    }

    const nextIsActive = isUnlinkingFlow
      ? false
      : (typeof is_active === 'boolean' ? is_active : item.is_active);

    await item.update({
      name: name ?? item.name,
      display_name: display_name ?? item.display_name,
      description: description ?? item.description,
      trigger_type: trigger_type ?? item.trigger_type,
      steps: steps ?? item.steps,
      template_key: effectiveTemplateKey || null,
      template_version: effectiveTemplateKey
        ? (effectiveTemplateVersion || parseIntOrNull(linkedTemplate?.version))
        : null,
      is_generic: typeof is_generic === 'boolean' ? is_generic : item.is_generic,
      is_active: nextIsActive,
    });
    const nextIsGeneric = typeof is_generic === 'boolean' ? is_generic : item.is_generic;
    if (nextIsGeneric || disciplinesProvided) {
      await AutomationFlowCatalogDiscipline.destroy({ where: { flow_catalog_id: item.id } });
      if (!nextIsGeneric && disciplinaCodes.length) {
        const rows = disciplinaCodes.map((code) => ({ flow_catalog_id: item.id, disciplina_code: code }));
        await AutomationFlowCatalogDiscipline.bulkCreate(rows);
      }
    }
    const updatedItem = await AutomationFlowCatalog.findByPk(item.id, {
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
    });
    return res.json(serializeCatalogItem(updatedItem, linkedTemplate));
  } catch (err) {
    console.error('Error updateCatalog', err);
    return res.status(500).json({ error: 'Error actualizando catálogo' });
  }
};

exports.toggleCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const item = await AutomationFlowCatalog.findByPk(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }
    const next = !item.is_active;
    if (next) {
      const linkedTemplate = await resolveLinkedTemplateForCatalog({
        templateKey: item.template_key,
        templateVersion: item.template_version,
      });
      if (!linkedTemplate) {
        return res.status(409).json({ error: 'linked_template_required' });
      }
    }
    await item.update({ is_active: next });
    const linkedTemplate = await resolveLinkedTemplateForCatalog({
      templateKey: item.template_key,
      templateVersion: item.template_version,
    });
    const updatedItem = await AutomationFlowCatalog.findByPk(item.id, {
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
    });
    return res.json(serializeCatalogItem(updatedItem, linkedTemplate));
  } catch (err) {
    console.error('Error toggleCatalog', err);
    return res.status(500).json({ error: 'Error actualizando estado' });
  }
};

exports.deleteCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const item = await AutomationFlowCatalog.findByPk(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }
    await item.destroy();
    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleteCatalog', err);
    return res.status(500).json({ error: 'Error eliminando catálogo' });
  }
};

exports.duplicateCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const item = await AutomationFlowCatalog.findByPk(req.params.id, {
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
    });
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }

    const names = await resolveAutomationCatalogDuplicateNames(item.id, {
      baseName: item.name,
      baseDisplayName: item.display_name || item.name,
    });
    const sourceLinkedTemplate = await resolveLinkedTemplateForCatalog({
      templateKey: item.template_key,
      templateVersion: item.template_version,
    });
    const duplicatedLinkedTemplate = await duplicateLinkedFlowTemplateForCatalog({
      sourceTemplate: sourceLinkedTemplate,
      names,
      actorUserId: Number(req.userData?.userId) || null,
    });

    const duplicated = await AutomationFlowCatalog.create({
      name: names.name,
      display_name: names.display_name,
      description: item.description || null,
      trigger_type: item.trigger_type,
      steps: sourceLinkedTemplate ? mapNodesToCatalogSteps(sourceLinkedTemplate.nodes) : (item.steps || []),
      template_key: duplicatedLinkedTemplate?.public_id || item.template_key || null,
      template_version: duplicatedLinkedTemplate?.version || parseIntOrNull(item.template_version),
      is_generic: !!item.is_generic,
      is_active: false,
    });

    const disciplinaCodes = Array.isArray(item.disciplinas)
      ? item.disciplinas
          .map((disc) => (typeof disc?.disciplina_code === 'string' ? disc.disciplina_code.trim() : null))
          .filter(Boolean)
      : [];

    if (!duplicated.is_generic && disciplinaCodes.length) {
      await AutomationFlowCatalogDiscipline.bulkCreate(
        disciplinaCodes.map((code) => ({ flow_catalog_id: duplicated.id, disciplina_code: code }))
      );
    }

    const createdItem = await AutomationFlowCatalog.findByPk(duplicated.id, {
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
    });
    const linkedTemplate = await resolveLinkedTemplateForCatalog({
      templateKey: createdItem.template_key,
      templateVersion: createdItem.template_version,
    });
    return res.status(201).json(serializeCatalogItem(createdItem, linkedTemplate));
  } catch (err) {
    console.error('Error duplicateCatalog', err);
    return res.status(500).json({ error: 'Error duplicando catálogo' });
  }
};

exports.setCatalogDisciplines = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const item = await AutomationFlowCatalog.findByPk(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'catalog_not_found' });
    }
    const disciplinaCodes = extractDisciplinaCodes(req.body || {});
    await AutomationFlowCatalogDiscipline.destroy({ where: { flow_catalog_id: item.id } });
    if (disciplinaCodes.length) {
      const rows = disciplinaCodes.map((code) => ({ flow_catalog_id: item.id, disciplina_code: code }));
      await AutomationFlowCatalogDiscipline.bulkCreate(rows);
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('Error setCatalogDisciplines', err);
    return res.status(500).json({ error: 'Error actualizando disciplinas' });
  }
};

exports.propagateCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const catalogId = Number(req.params.id);
    if (!Number.isFinite(catalogId) || catalogId <= 0) {
      return res.status(400).json({ error: 'invalid_catalog_id' });
    }

    const result = await automationDefaultsService.propagateCatalogAutomationToClinics({
      catalogId,
      actorUserId: Number(req.userData?.userId) || null,
    });

    if (!result?.success) {
      return res.status(404).json({ error: result?.error || 'catalog_not_found' });
    }

    if (Number(result?.failed || 0) === 0) {
      const item = await AutomationFlowCatalog.findByPk(catalogId);
      if (item) {
        await item.update({
          last_propagated_at: new Date(),
          last_propagated_template_key: cleanString(item.template_key),
          last_propagated_template_version: parseIntOrNull(item.template_version),
        });
      }
    }

    return res.json(result);
  } catch (err) {
    console.error('Error propagateCatalog', err);
    return res.status(500).json({ error: 'Error propagando automatización a clínicas' });
  }
};
