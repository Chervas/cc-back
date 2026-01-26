'use strict';

const db = require('../../models');
const {
  AutomationFlowCatalog,
  AutomationFlowCatalogDiscipline,
} = db;

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

exports.listCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const items = await AutomationFlowCatalog.findAll({
      include: [{ model: AutomationFlowCatalogDiscipline, as: 'disciplinas' }],
      order: [['display_name', 'ASC']],
    });
    return res.json(items);
  } catch (err) {
    console.error('Error listCatalog', err);
    return res.status(500).json({ error: 'Error obteniendo catálogo' });
  }
};

exports.createCatalog = async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return;
    const { name, display_name, description, trigger_type, steps, is_generic = false, is_active = true } = req.body || {};
    if (!name || !trigger_type || !steps) {
      return res.status(400).json({ error: 'name, trigger_type y steps son obligatorios' });
    }

    const item = await AutomationFlowCatalog.create({
      name,
      display_name: display_name || null,
      description: description || null,
      trigger_type,
      steps,
      is_generic: !!is_generic,
      is_active: !!is_active,
    });
    return res.status(201).json(item);
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

    const { name, display_name, description, trigger_type, steps, is_generic, is_active } = req.body || {};
    await item.update({
      name: name ?? item.name,
      display_name: display_name ?? item.display_name,
      description: description ?? item.description,
      trigger_type: trigger_type ?? item.trigger_type,
      steps: steps ?? item.steps,
      is_generic: typeof is_generic === 'boolean' ? is_generic : item.is_generic,
      is_active: typeof is_active === 'boolean' ? is_active : item.is_active,
    });
    return res.json(item);
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
    return res.json({ success: true, is_active: next });
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
    const disciplinaCodes = Array.isArray(req.body?.disciplina_codes) ? req.body.disciplina_codes : [];
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
