'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const ChatFlowTemplate = db.ChatFlowTemplate;

function toBool(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function normalizeTags(tags) {
  if (tags === undefined) return undefined;
  if (tags === null) return null;
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    return tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return tags;
}

function mapTemplate(row) {
  const data = row?.toJSON ? row.toJSON() : row;
  return {
    id: data.id,
    name: data.name,
    tags: data.tags ?? null,
    is_active: !!data.is_active,
    flow: data.flow ?? null,
    flows: data.flows ?? null,
    texts: data.texts ?? null,
    appearance: data.appearance ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

exports.listChatFlowTemplates = async (req, res) => {
  try {
    const { active, search } = req.query || {};
    const where = {};

    const isActive = toBool(active, undefined);
    if (isActive !== undefined) where.is_active = isActive;

    if (search && String(search).trim()) {
      where.name = { [Op.like]: `%${String(search).trim()}%` };
    }

    const rows = await ChatFlowTemplate.findAll({
      where,
      order: [['updated_at', 'DESC']],
    });

    res.status(200).json(rows.map(mapTemplate));
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo plantillas de flujo', error: error.message });
  }
};

exports.getChatFlowTemplate = async (req, res) => {
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });
    res.status(200).json(mapTemplate(row));
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo plantilla', error: error.message });
  }
};

exports.createChatFlowTemplate = async (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name ? String(body.name).trim() : '';

    if (!name) return res.status(400).json({ message: 'name es obligatorio' });

    const tags = normalizeTags(body.tags);
    const is_active = toBool(body.is_active, true);

    const flow = body.flow ?? null;
    const flows = body.flows ?? null;
    const texts = body.texts ?? null;
    const appearance = body.appearance ?? null;

    const hasSingleFlow = !!flow;
    const hasMultiFlows = Array.isArray(flows) && flows.length > 0;
    if (!hasSingleFlow && !hasMultiFlows) {
      return res.status(400).json({ message: 'Debe incluirse flow o flows (no vacío)' });
    }

    const created = await ChatFlowTemplate.create({
      name,
      tags: tags === undefined ? null : tags,
      is_active,
      flow,
      flows,
      texts,
      appearance,
    });

    res.status(201).json(mapTemplate(created));
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: 'Ya existe una plantilla con ese name' });
    }
    res.status(500).json({ message: 'Error creando plantilla', error: error.message });
  }
};

exports.updateChatFlowTemplate = async (req, res) => {
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });

    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const name = body.name ? String(body.name).trim() : '';
      if (!name) return res.status(400).json({ message: 'name no puede ser vacío' });
      updates.name = name;
    }
    if (body.tags !== undefined) updates.tags = normalizeTags(body.tags);
    if (body.is_active !== undefined) updates.is_active = toBool(body.is_active, row.is_active);
    if (body.flow !== undefined) updates.flow = body.flow;
    if (body.flows !== undefined) updates.flows = body.flows;
    if (body.texts !== undefined) updates.texts = body.texts;
    if (body.appearance !== undefined) updates.appearance = body.appearance;

    const nextFlow = updates.flow !== undefined ? updates.flow : row.flow;
    const nextFlows = updates.flows !== undefined ? updates.flows : row.flows;
    const hasSingleFlow = !!nextFlow;
    const hasMultiFlows = Array.isArray(nextFlows) && nextFlows.length > 0;
    if (!hasSingleFlow && !hasMultiFlows) {
      return res.status(400).json({ message: 'Debe incluirse flow o flows (no vacío)' });
    }

    await row.update(updates);
    res.status(200).json(mapTemplate(row));
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: 'Ya existe una plantilla con ese name' });
    }
    res.status(500).json({ message: 'Error actualizando plantilla', error: error.message });
  }
};

exports.deleteChatFlowTemplate = async (req, res) => {
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });

    await row.destroy();
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Error eliminando plantilla', error: error.message });
  }
};

exports.duplicateChatFlowTemplate = async (req, res) => {
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });

    const baseName = (req.body?.name ? String(req.body.name).trim() : '') || `${row.name} (copia)`;

    const tags = row.tags ?? null;
    const is_active = row.is_active;
    const flow = row.flow ?? null;
    const flows = row.flows ?? null;
    const texts = row.texts ?? null;
    const appearance = row.appearance ?? null;

    let name = baseName;
    for (let i = 0; i < 50; i += 1) {
      try {
        const created = await ChatFlowTemplate.create({
          name,
          tags,
          is_active,
          flow,
          flows,
          texts,
          appearance,
        });
        return res.status(201).json(mapTemplate(created));
      } catch (error) {
        if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
        name = `${baseName} (${i + 2})`;
      }
    }

    res.status(409).json({ message: 'No se pudo duplicar: demasiados nombres en conflicto' });
  } catch (error) {
    res.status(500).json({ message: 'Error duplicando plantilla', error: error.message });
  }
};

