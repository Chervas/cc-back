'use strict';

const db = require('../../models');
const {
  AutomationFlowCatalog,
  AutomationFlowCatalogDiscipline,
  AutomationFlowTemplateV2,
} = db;

const CATALOG_TRIGGER_TYPES = [
  'lead_nuevo',
  'appointment_created',
  'appointment_confirmed',
  'appointment_cancelled',
  'appointment_reminder_window',
  'patient_inactive',
  'quote_accepted',
  'treatment_completed',
  'birthday',
];

const CATALOG_TRIGGER_TYPE_SET = new Set(CATALOG_TRIGGER_TYPES);

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((n) => !Number.isNaN(n));

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

async function resolveLinkedTemplateByKey(templateKey, templateVersion) {
  const cleanKey = typeof templateKey === 'string' ? templateKey.trim() : '';
  if (!cleanKey) return null;

  const where = { template_key: cleanKey };
  if (templateVersion) {
    where.version = templateVersion;
  }

  return AutomationFlowTemplateV2.findOne({
    where,
    order: [['version', 'DESC']],
    raw: true,
  });
}

async function loadLinkedTemplatesForItems(items) {
  const rows = Array.isArray(items) ? items : [];
  const requests = rows
    .map((item) => {
      const data = item?.toJSON ? item.toJSON() : item;
      const templateKey = typeof data?.template_key === 'string' ? data.template_key.trim() : '';
      const templateVersion = Number.isInteger(Number(data?.template_version)) ? Number(data.template_version) : null;
      if (!templateKey) return null;
      return {
        itemId: Number(data.id),
        templateKey,
        templateVersion,
      };
    })
    .filter(Boolean);

  const results = await Promise.all(
    requests.map(async (request) => ({
      itemId: request.itemId,
      template: await resolveLinkedTemplateByKey(request.templateKey, request.templateVersion),
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
  return {
    ...data,
    trigger_type: normalizeCatalogTriggerType(effectiveTriggerType),
    steps: effectiveSteps,
    template_key: typeof data?.template_key === 'string' ? data.template_key : null,
    template_version: Number.isInteger(Number(data?.template_version)) ? Number(data.template_version) : null,
    linked_template: linkedTemplate
      ? {
          template_key: linkedTemplate.template_key,
          template_version: Number(linkedTemplate.version),
          name: linkedTemplate.name,
          trigger_type: linkedTemplate.trigger_type,
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
    const linkedTemplate = await resolveLinkedTemplateByKey(item.template_key, item.template_version);
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
    const template_version = Number.isInteger(Number(payload.template_version)) ? Number(payload.template_version) : null;
    const is_generic = typeof payload.is_generic === 'boolean' ? payload.is_generic : !!payload.isGeneric;
    const is_active = typeof payload.is_active === 'boolean' ? payload.is_active : (typeof payload.isActive === 'boolean' ? payload.isActive : true);
    const disciplinaCodes = extractDisciplinaCodes(payload);
    const linkedTemplate = await resolveLinkedTemplateByKey(template_key, template_version);

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
      template_version: template_version || Number(linkedTemplate.version),
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
      ? (Number.isInteger(Number(payload.template_version)) ? Number(payload.template_version) : null)
      : undefined;
    const is_generic = typeof payload.is_generic === 'boolean' ? payload.is_generic : (typeof payload.isGeneric === 'boolean' ? payload.isGeneric : undefined);
    const is_active = typeof payload.is_active === 'boolean' ? payload.is_active : (typeof payload.isActive === 'boolean' ? payload.isActive : undefined);
    const disciplinaCodes = extractDisciplinaCodes(payload);
    const disciplinesProvided = Object.prototype.hasOwnProperty.call(payload, 'disciplina_codes');
    const effectiveTemplateKey = template_key !== undefined ? template_key : item.template_key;
    const effectiveTemplateVersion = template_version !== undefined ? template_version : item.template_version;
    const linkedTemplate = effectiveTemplateKey
      ? await resolveLinkedTemplateByKey(effectiveTemplateKey, effectiveTemplateVersion)
      : null;
    const trigger_type = linkedTemplate?.trigger_type ? normalizeCatalogTriggerType(linkedTemplate.trigger_type) : item.trigger_type;
    const steps = linkedTemplate ? mapNodesToCatalogSteps(linkedTemplate.nodes) : item.steps;

    if (!effectiveTemplateKey) {
      return res.status(400).json({ error: 'template_key es obligatorio' });
    }
    if (!linkedTemplate) {
      return res.status(404).json({ error: 'linked_template_not_found' });
    }
    if (!CATALOG_TRIGGER_TYPE_SET.has(trigger_type)) {
      return res.status(400).json({
        error: 'invalid_trigger_type',
        message: `trigger_type no soportado: ${String(trigger_type)}`,
        allowed: CATALOG_TRIGGER_TYPES,
      });
    }

    await item.update({
      name: name ?? item.name,
      display_name: display_name ?? item.display_name,
      description: description ?? item.description,
      trigger_type: trigger_type ?? item.trigger_type,
      steps: steps ?? item.steps,
      template_key: effectiveTemplateKey,
      template_version: effectiveTemplateVersion || Number(linkedTemplate.version),
      is_generic: typeof is_generic === 'boolean' ? is_generic : item.is_generic,
      is_active: typeof is_active === 'boolean' ? is_active : item.is_active,
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
    await item.update({ is_active: next });
    const linkedTemplate = await resolveLinkedTemplateByKey(item.template_key, item.template_version);
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
