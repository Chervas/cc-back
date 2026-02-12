'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const ChatFlowTemplate = db.ChatFlowTemplate;
const Clinica = db.Clinica;

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => parseInt(String(v).trim(), 10))
  .filter((n) => Number.isFinite(n));

function isAdmin(req) {
  const uid = Number(req.userData?.userId);
  return !!uid && ADMIN_USER_IDS.includes(uid);
}

function assertAdmin(req, res) {
  if (!isAdmin(req)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

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

function normalizeDisciplinaCodes(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : String(v).trim().toLowerCase()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  return value;
}

function normalizeDisciplinesFromClinicConfig(configuracion) {
  const cfg = configuracion && typeof configuracion === 'object' ? configuracion : {};
  const raw = Array.isArray(cfg.disciplinas) ? cfg.disciplinas : (cfg.disciplina ? [cfg.disciplina] : []);
  return raw
    .map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : String(d).trim().toLowerCase()))
    .filter(Boolean);
}

function matchesDisciplines(templateDisciplinaCodes, clinicDisciplinaCodes) {
  const templateCodes = Array.isArray(templateDisciplinaCodes)
    ? templateDisciplinaCodes
      .map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : String(c).trim().toLowerCase()))
      .filter(Boolean)
    : [];
  const clinicCodes = Array.isArray(clinicDisciplinaCodes)
    ? clinicDisciplinaCodes
      .map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : String(c).trim().toLowerCase()))
      .filter(Boolean)
    : [];

  // Sin filtro de clínica => no filtrar.
  if (clinicCodes.length === 0) return true;
  // Plantilla "general" (sin disciplinas asignadas) => visible para todas.
  if (templateCodes.length === 0) return true;
  // Intersección
  return templateCodes.some((code) => clinicCodes.includes(code));
}

function mapTemplate(row) {
  const data = row?.toJSON ? row.toJSON() : row;
  return {
    id: data.id,
    name: data.name,
    tags: data.tags ?? null,
    disciplina_codes: data.disciplina_codes ?? null,
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
    const { active, search, clinic_id } = req.query || {};
    const where = {};
    const admin = isAdmin(req);

    // Para clínicas (no admin): solo plantillas activas.
    const isActive = toBool(active, undefined);
    if (!admin) {
      where.is_active = true;
    } else if (isActive !== undefined) {
      where.is_active = isActive;
    }

    if (search && String(search).trim()) {
      where.name = { [Op.like]: `%${String(search).trim()}%` };
    }

    const clinicIdParsed = clinic_id ? parseInt(String(clinic_id), 10) : null;
    let clinicDisciplinaCodes = [];
    if (Number.isFinite(clinicIdParsed) && clinicIdParsed > 0) {
      const clinica = await Clinica.findOne({
        where: { id_clinica: clinicIdParsed },
        attributes: ['id_clinica', 'configuracion'],
        raw: true,
      });
      clinicDisciplinaCodes = normalizeDisciplinesFromClinicConfig(clinica?.configuracion);
    }

    const rows = await ChatFlowTemplate.findAll({
      where,
      order: [['updated_at', 'DESC']],
    });

    const filtered = (rows || []).filter((row) => matchesDisciplines(row?.disciplina_codes, clinicDisciplinaCodes));
    res.status(200).json(filtered.map(mapTemplate));
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo plantillas de flujo', error: error.message });
  }
};

exports.getChatFlowTemplate = async (req, res) => {
  try {
    const admin = isAdmin(req);
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });
    if (!admin && !row.is_active) return res.status(404).json({ message: 'Plantilla no encontrada' });
    res.status(200).json(mapTemplate(row));
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo plantilla', error: error.message });
  }
};

exports.createChatFlowTemplate = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const body = req.body || {};
    const name = body.name ? String(body.name).trim() : '';

    if (!name) return res.status(400).json({ message: 'name es obligatorio' });

    const tags = normalizeTags(body.tags);
    const disciplina_codes = normalizeDisciplinaCodes(body.disciplina_codes);
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
      disciplina_codes: disciplina_codes === undefined ? null : disciplina_codes,
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
  if (!assertAdmin(req, res)) return;
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
    if (body.disciplina_codes !== undefined) updates.disciplina_codes = normalizeDisciplinaCodes(body.disciplina_codes);
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
  if (!assertAdmin(req, res)) return;
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });

    await row.destroy();
    return res.status(200).json({ success: true, id: Number(req.params.id) });
  } catch (error) {
    return res.status(500).json({ message: 'Error eliminando plantilla', error: error.message });
  }
};

exports.duplicateChatFlowTemplate = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });

    const baseName = (req.body?.name ? String(req.body.name).trim() : '') || `${row.name} (copia)`;

    const tags = row.tags ?? null;
    const disciplina_codes = row.disciplina_codes ?? null;
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
          disciplina_codes,
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
