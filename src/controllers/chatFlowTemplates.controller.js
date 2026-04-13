'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const ChatFlowTemplate = db.ChatFlowTemplate;
const Clinica = db.Clinica;
const IntakeConfig = db.IntakeConfig;

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1,44')
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
  const dedupe = (arr) => {
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  };
  if (Array.isArray(value)) {
    return dedupe(value
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : String(v).trim().toLowerCase()))
      .filter(Boolean));
  }
  if (typeof value === 'string') {
    return dedupe(value
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean));
  }
  return value;
}

async function removeDefaultDisciplinesFromOtherTemplates({ excludeTemplateId, disciplinaCodes, transaction }) {
  const targetCodes = normalizeDisciplinaCodes(disciplinaCodes) || [];
  if (!Array.isArray(targetCodes) || targetCodes.length === 0) return;

  const where = {
    is_default_for: { [Op.ne]: null },
  };
  if (excludeTemplateId !== undefined && excludeTemplateId !== null) {
    where.id = { [Op.ne]: Number(excludeTemplateId) };
  }

  const allTemplates = await ChatFlowTemplate.findAll({ where, transaction });
  for (const other of allTemplates) {
    const otherDefaults = Array.isArray(other.is_default_for)
      ? normalizeDisciplinaCodes(other.is_default_for) || []
      : [];
    const cleaned = otherDefaults.filter((code) => !targetCodes.includes(code));
    if (cleaned.length !== otherDefaults.length) {
      await other.update({ is_default_for: cleaned.length > 0 ? cleaned : null }, { transaction });
    }
  }
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

function cloneJson(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeConfigObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isDefaultTemplateForClinic(templateDefaultCodes, clinicDisciplinaCodes) {
  const defaultCodes = normalizeDisciplinaCodes(templateDefaultCodes) || [];
  if (!Array.isArray(defaultCodes) || defaultCodes.length === 0) return false;
  if (defaultCodes.some((code) => ['*', 'all', '_all', 'todas'].includes(code))) return true;

  const clinicCodes = normalizeDisciplinaCodes(clinicDisciplinaCodes) || [];
  if (!Array.isArray(clinicCodes) || clinicCodes.length === 0) return false;
  return defaultCodes.some((code) => clinicCodes.includes(code));
}

function extractTemplateFlowRules(template) {
  const base = template?.toJSON ? template.toJSON() : template;
  if (!base) return [];

  if (Array.isArray(base.flows) && base.flows.length > 0) {
    return base.flows
      .filter((flowRule) => flowRule?.flow?.steps?.length > 0)
      .map((flowRule, index) => ({
        index,
        name: flowRule.name || base.name,
        url_rules: Array.isArray(flowRule.url_rules) && flowRule.url_rules.length ? flowRule.url_rules : ['*'],
        flow: flowRule.flow,
      }));
  }

  if (base.flow?.steps?.length > 0) {
    return [{
      index: 0,
      name: base.name,
      url_rules: ['*'],
      flow: base.flow,
    }];
  }

  return [];
}

function getCatalogTemplateId(flowRule) {
  const value = flowRule?.catalog_template_id ?? flowRule?.template_id ?? flowRule?._templateId;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCatalogTemplateFlowIndex(flowRule) {
  const value = flowRule?.catalog_template_flow_index ?? flowRule?.template_flow_index ?? 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findCatalogFlowIndex(flows, templateId, templateFlowIndex) {
  return (flows || []).findIndex((flowRule) => (
    getCatalogTemplateId(flowRule) === Number(templateId)
    && getCatalogTemplateFlowIndex(flowRule) === Number(templateFlowIndex)
  ));
}

function buildCatalogFlowRule({ template, flowRule, forceDefault, forceClosed, enabled }) {
  const base = template?.toJSON ? template.toJSON() : template;
  return {
    id: `catalog_${base.id}_${flowRule.index}`,
    name: flowRule.name || base.name,
    is_default: !!forceDefault,
    enabled: !!enabled,
    url_rules: cloneJson(flowRule.url_rules || ['*']),
    ...(forceClosed ? { show_when_clinic_closed: true } : {}),
    template_id: base.id,
    catalog_template_id: base.id,
    template_flow_index: flowRule.index,
    catalog_template_flow_index: flowRule.index,
    template_source: 'chat_flow_catalog',
    flow: cloneJson(flowRule.flow),
  };
}

async function propagateChatFlowTemplateToExistingConfigs(template) {
  if (!IntakeConfig) return { updated: 0, skipped: 0, reason: 'intake_config_unavailable' };

  const base = template?.toJSON ? template.toJSON() : template;
  const templateId = Number(base?.id);
  const templateRules = extractTemplateFlowRules(base);
  if (!Number.isFinite(templateId) || templateRules.length === 0) {
    return { updated: 0, skipped: 0, reason: 'empty_template' };
  }

  const [configs, clinics] = await Promise.all([
    IntakeConfig.findAll({
      where: {
        clinic_id: { [Op.ne]: null },
        assignment_scope: 'clinic',
      },
    }),
    Clinica.findAll({
      attributes: ['id_clinica', 'configuracion'],
      raw: true,
    }),
  ]);
  const configByClinicId = new Map((configs || [])
    .map((record) => [Number(record.clinic_id), record])
    .filter(([clinicId]) => Number.isFinite(clinicId)));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const clinic of clinics || []) {
    const clinicId = Number(clinic.id_clinica);
    if (!Number.isFinite(clinicId)) {
      skipped += 1;
      continue;
    }

    const record = configByClinicId.get(clinicId) || null;
    const clinicDisciplinaCodes = normalizeDisciplinesFromClinicConfig(clinic.configuracion);
    const disciplineMatches = matchesDisciplines(base.disciplina_codes, clinicDisciplinaCodes);
    const shouldBeDefault = !!base.is_active && isDefaultTemplateForClinic(base.is_default_for, clinicDisciplinaCodes) && !base.show_when_clinic_closed;
    const shouldBeClosed = !!base.is_active && !!base.show_when_clinic_closed;
    const shouldAddIfMissing = !!base.is_active && disciplineMatches;

    const currentConfig = normalizeConfigObject(record?.config);
    const flows = Array.isArray(currentConfig.flows) ? cloneJson(currentConfig.flows) : [];
    const hadExistingCatalogCopy = flows.some((flowRule) => getCatalogTemplateId(flowRule) === templateId);

    if (!shouldAddIfMissing && !hadExistingCatalogCopy) {
      skipped += 1;
      continue;
    }

    let changed = false;
    const nextFlows = [...flows];

    for (const templateRule of templateRules) {
      const existingIndex = findCatalogFlowIndex(nextFlows, templateId, templateRule.index);
      if (!shouldAddIfMissing && existingIndex < 0) continue;

      const enabled = shouldBeDefault || shouldBeClosed
        ? true
        : (existingIndex >= 0 ? !!nextFlows[existingIndex].enabled : false);
      const nextRule = buildCatalogFlowRule({
        template: base,
        flowRule: templateRule,
        forceDefault: shouldBeDefault && templateRule.index === 0,
        forceClosed: shouldBeClosed,
        enabled: !!base.is_active && enabled,
      });

      if (existingIndex >= 0) {
        const previous = nextFlows[existingIndex] || {};
        const preservedDefault = !shouldBeDefault && !shouldBeClosed && !!base.is_active && disciplineMatches
          ? !!previous.is_default
          : false;
        nextFlows[existingIndex] = {
          ...previous,
          ...nextRule,
          id: previous.id || nextRule.id,
          enabled: !!base.is_active && enabled,
          is_default: shouldBeDefault && templateRule.index === 0 ? true : preservedDefault,
        };
      } else {
        nextFlows.push(nextRule);
      }
      changed = true;
    }

    if (shouldBeDefault) {
      for (const flowRule of nextFlows) {
        const isThisTemplateDefault = getCatalogTemplateId(flowRule) === templateId && getCatalogTemplateFlowIndex(flowRule) === 0;
        if (flowRule.is_default !== isThisTemplateDefault) {
          flowRule.is_default = isThisTemplateDefault;
          changed = true;
        }
      }
    } else if (!base.is_active || !disciplineMatches) {
      for (const flowRule of nextFlows) {
        if (getCatalogTemplateId(flowRule) !== templateId) continue;
        if (flowRule.enabled !== false || flowRule.is_default !== false) {
          flowRule.enabled = false;
          flowRule.is_default = false;
          changed = true;
        }
      }
    }

    const defaultRule = nextFlows.find((flowRule) => flowRule.is_default && flowRule.flow?.steps?.length > 0);
    const nextConfig = {
      ...currentConfig,
      flows: nextFlows,
      ...(defaultRule ? { flow: cloneJson(defaultRule.flow) } : {}),
    };

    if (changed && JSON.stringify(currentConfig.flows || []) !== JSON.stringify(nextFlows)) {
      if (record) {
        await record.update({ config: nextConfig });
        updated += 1;
      } else {
        await IntakeConfig.create({
          clinic_id: clinicId,
          group_id: null,
          assignment_scope: 'clinic',
          domains: [],
          config: nextConfig,
          hmac_key: null,
        });
        created += 1;
      }
    } else {
      skipped += 1;
    }
  }

  return { created, updated, skipped };
}

function mapTemplate(row) {
  const data = row?.toJSON ? row.toJSON() : row;
  return {
    id: data.id,
    name: data.name,
    tags: data.tags ?? null,
    disciplina_codes: data.disciplina_codes ?? null,
    is_default_for: data.is_default_for ?? null,
    show_when_clinic_closed: !!data.show_when_clinic_closed,
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
    const is_default_for = normalizeDisciplinaCodes(body.is_default_for);
    const is_active = toBool(body.is_active, true);
    const show_when_clinic_closed = toBool(body.show_when_clinic_closed, false);

    const flow = body.flow ?? null;
    const flows = body.flows ?? null;
    const texts = body.texts ?? null;
    const appearance = body.appearance ?? null;

    const hasSingleFlow = !!flow;
    const hasMultiFlows = Array.isArray(flows) && flows.length > 0;
    if (!hasSingleFlow && !hasMultiFlows) {
      return res.status(400).json({ message: 'Debe incluirse flow o flows (no vacío)' });
    }

    const created = await db.sequelize.transaction(async (transaction) => {
      const defaults = Array.isArray(is_default_for) && is_default_for.length > 0 ? is_default_for : null;
      if (defaults) {
        await removeDefaultDisciplinesFromOtherTemplates({
          excludeTemplateId: null,
          disciplinaCodes: defaults,
          transaction,
        });
      }

      return ChatFlowTemplate.create({
        name,
        tags: tags === undefined ? null : tags,
        disciplina_codes: disciplina_codes === undefined ? null : disciplina_codes,
        is_default_for: defaults,
        show_when_clinic_closed,
        is_active,
        flow,
        flows,
        texts,
        appearance,
      }, { transaction });
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
    let newDefaultDisciplines = undefined;

    if (body.name !== undefined) {
      const name = body.name ? String(body.name).trim() : '';
      if (!name) return res.status(400).json({ message: 'name no puede ser vacío' });
      updates.name = name;
    }
    if (body.tags !== undefined) updates.tags = normalizeTags(body.tags);
    if (body.disciplina_codes !== undefined) updates.disciplina_codes = normalizeDisciplinaCodes(body.disciplina_codes);
    if (body.is_default_for !== undefined) {
      const defaults = normalizeDisciplinaCodes(body.is_default_for) || [];
      updates.is_default_for = defaults.length > 0 ? defaults : null;
      newDefaultDisciplines = defaults;
    }
    if (body.show_when_clinic_closed !== undefined) {
      updates.show_when_clinic_closed = toBool(body.show_when_clinic_closed, row.show_when_clinic_closed);
    }
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

    await db.sequelize.transaction(async (transaction) => {
      if (Array.isArray(newDefaultDisciplines) && newDefaultDisciplines.length > 0) {
        await removeDefaultDisciplinesFromOtherTemplates({
          excludeTemplateId: row.id,
          disciplinaCodes: newDefaultDisciplines,
          transaction,
        });
      }
      await row.update(updates, { transaction });
    });
    await row.reload();
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

exports.propagateChatFlowTemplate = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const row = await ChatFlowTemplate.findByPk(req.params.id);
    if (!row) return res.status(404).json({ message: 'Plantilla no encontrada' });

    const propagation = await propagateChatFlowTemplateToExistingConfigs(row);
    return res.status(200).json({
      success: true,
      template: mapTemplate(row),
      propagation,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Error propagando plantilla', error: error.message });
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
    // Una copia nunca debe heredar defaults por disciplina para evitar colisiones.
    const is_default_for = null;
    const show_when_clinic_closed = !!row.show_when_clinic_closed;
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
          is_default_for,
          show_when_clinic_closed,
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
