'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const AppointmentFlowTemplate = db.AppointmentFlowTemplate;
const Clinica = db.Clinica;

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => parseInt(String(v).trim(), 10))
  .filter((n) => Number.isFinite(n));

function isAdmin(req) {
  const uid = Number(req.userData?.userId);
  return !!uid && ADMIN_USER_IDS.includes(uid);
}

function parseBool(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' && value.includes(',')
    ? value.split(',')[0].trim()
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  return str || null;
}

function normalizeDiscipline(value) {
  const str = normalizeString(value);
  return str ? str.toLowerCase() : null;
}

function normalizeSteps(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  return value;
}

function mapTemplate(row) {
  const item = row?.toJSON ? row.toJSON() : row;
  return {
    id: item.id,
    name: item.name,
    description: item.description ?? null,
    discipline: item.discipline,
    version: item.version || '1.0',
    steps: Array.isArray(item.steps) ? item.steps : [],
    is_system: !!item.is_system,
    clinic_id: item.clinic_id ?? null,
    group_id: item.group_id ?? null,
    is_active: item.is_active !== false,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

async function resolveClinicContext(clinicId) {
  if (!Number.isFinite(clinicId) || clinicId <= 0) {
    return { clinic_id: null, group_id: null };
  }

  const row = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });

  return {
    clinic_id: row?.id_clinica ? Number(row.id_clinica) : clinicId,
    group_id: row?.grupoClinicaId ? Number(row.grupoClinicaId) : null,
  };
}

function canMutateTemplate(req, templateRow) {
  if (!templateRow) return false;
  if (isAdmin(req)) return true;
  // Catálogo del sistema solo editable por admin.
  if (templateRow.is_system) return false;
  return true;
}

exports.listAppointmentFlowTemplates = async (req, res) => {
  try {
    const admin = isAdmin(req);
    const clinicId = parseIntOrNull(req.query?.clinic_id);
    const groupIdFromQuery = parseIntOrNull(req.query?.group_id);
    const discipline = normalizeDiscipline(req.query?.discipline);
    const active = parseBool(req.query?.active, admin ? undefined : true);
    const search = normalizeString(req.query?.search);

    const where = {};

    if (active !== undefined) {
      where.is_active = active;
    }

    if (discipline) {
      where.discipline = discipline;
    }

    if (search) {
      where.name = { [Op.like]: `%${search}%` };
    }

    let scopeOr = null;
    if (Number.isFinite(clinicId) && clinicId > 0) {
      const context = await resolveClinicContext(clinicId);
      scopeOr = [
        { is_system: true },
        { clinic_id: context.clinic_id },
      ];
      if (context.group_id) {
        scopeOr.push({ group_id: context.group_id });
      }
    } else if (Number.isFinite(groupIdFromQuery) && groupIdFromQuery > 0) {
      scopeOr = [
        { is_system: true },
        { group_id: groupIdFromQuery },
      ];
    } else if (!admin) {
      // Si no tenemos contexto (clínica/grupo), usuario no-admin solo ve catálogo sistema.
      scopeOr = [{ is_system: true }];
    }

    if (scopeOr) {
      where[Op.and] = [{ [Op.or]: scopeOr }];
    }

    const rows = await AppointmentFlowTemplate.findAll({
      where,
      order: [
        ['is_system', 'DESC'],
        ['updated_at', 'DESC'],
        ['id', 'DESC'],
      ],
    });

    return res.status(200).json({ success: true, data: rows.map(mapTemplate) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error cargando plantillas de flujo', error: error.message });
  }
};

exports.getAppointmentFlowTemplate = async (req, res) => {
  try {
    const id = parseIntOrNull(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido' });
    }

    const row = await AppointmentFlowTemplate.findByPk(id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });
    }

    if (!isAdmin(req) && row.is_active === false) {
      return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });
    }

    return res.status(200).json({ success: true, data: mapTemplate(row) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error cargando plantilla', error: error.message });
  }
};

exports.createAppointmentFlowTemplate = async (req, res) => {
  try {
    const admin = isAdmin(req);
    const body = req.body || {};

    const name = normalizeString(body.name);
    const discipline = normalizeDiscipline(body.discipline);
    const description = normalizeString(body.description);
    const version = normalizeString(body.version) || '1.0';
    const steps = normalizeSteps(body.steps);

    if (!name) {
      return res.status(400).json({ success: false, message: 'name es obligatorio' });
    }
    if (!discipline) {
      return res.status(400).json({ success: false, message: 'discipline es obligatorio' });
    }
    if (!Array.isArray(steps)) {
      return res.status(400).json({ success: false, message: 'steps debe ser un array' });
    }

    const clinic_id = parseIntOrNull(body.clinic_id);
    const group_id = parseIntOrNull(body.group_id);
    const is_system = admin ? parseBool(body.is_system, false) : false;
    const is_active = parseBool(body.is_active, true);

    const created = await AppointmentFlowTemplate.create({
      name,
      description,
      discipline,
      version,
      steps,
      is_system,
      clinic_id,
      group_id,
      is_active,
    });

    return res.status(201).json({ success: true, data: mapTemplate(created) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error creando plantilla', error: error.message });
  }
};

exports.updateAppointmentFlowTemplate = async (req, res) => {
  try {
    const id = parseIntOrNull(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido' });
    }

    const row = await AppointmentFlowTemplate.findByPk(id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });
    }

    if (!canMutateTemplate(req, row)) {
      return res.status(403).json({ success: false, message: 'No autorizado para modificar esta plantilla' });
    }

    const admin = isAdmin(req);
    const body = req.body || {};
    const updates = {};

    if (body.name !== undefined) {
      const name = normalizeString(body.name);
      if (!name) {
        return res.status(400).json({ success: false, message: 'name no puede estar vacío' });
      }
      updates.name = name;
    }

    if (body.description !== undefined) updates.description = normalizeString(body.description);

    if (body.discipline !== undefined) {
      const discipline = normalizeDiscipline(body.discipline);
      if (!discipline) {
        return res.status(400).json({ success: false, message: 'discipline no puede estar vacío' });
      }
      updates.discipline = discipline;
    }

    if (body.version !== undefined) {
      updates.version = normalizeString(body.version) || row.version || '1.0';
    }

    if (body.steps !== undefined) {
      const steps = normalizeSteps(body.steps);
      if (!Array.isArray(steps)) {
        return res.status(400).json({ success: false, message: 'steps debe ser un array' });
      }
      updates.steps = steps;
    }

    if (body.clinic_id !== undefined) updates.clinic_id = parseIntOrNull(body.clinic_id);
    if (body.group_id !== undefined) updates.group_id = parseIntOrNull(body.group_id);
    if (body.is_active !== undefined) updates.is_active = parseBool(body.is_active, row.is_active);

    if (admin && body.is_system !== undefined) {
      updates.is_system = parseBool(body.is_system, row.is_system);
    }

    await row.update(updates);
    return res.status(200).json({ success: true, data: mapTemplate(row) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error actualizando plantilla', error: error.message });
  }
};

exports.deleteAppointmentFlowTemplate = async (req, res) => {
  try {
    const id = parseIntOrNull(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido' });
    }

    const row = await AppointmentFlowTemplate.findByPk(id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });
    }

    if (!canMutateTemplate(req, row)) {
      return res.status(403).json({ success: false, message: 'No autorizado para eliminar esta plantilla' });
    }

    await row.destroy();
    return res.status(200).json({ success: true, data: { id } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error eliminando plantilla', error: error.message });
  }
};

exports.duplicateAppointmentFlowTemplate = async (req, res) => {
  try {
    const id = parseIntOrNull(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido' });
    }

    const row = await AppointmentFlowTemplate.findByPk(id);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Plantilla no encontrada' });
    }

    const body = req.body || {};
    const admin = isAdmin(req);

    const baseName = normalizeString(body.name) || `${row.name} (copia)`;
    const clinic_id = body.clinic_id !== undefined ? parseIntOrNull(body.clinic_id) : row.clinic_id;
    const group_id = body.group_id !== undefined ? parseIntOrNull(body.group_id) : row.group_id;

    // Una copia hecha por usuario no-admin nunca se publica como sistema.
    const is_system = admin ? parseBool(body.is_system, false) : false;

    let nextName = baseName;
    let attempt = 1;
    while (attempt <= 30) {
      const exists = await AppointmentFlowTemplate.findOne({ where: { name: nextName } });
      if (!exists) break;
      attempt += 1;
      nextName = `${baseName} (${attempt})`;
    }

    const created = await AppointmentFlowTemplate.create({
      name: nextName,
      description: row.description,
      discipline: row.discipline,
      version: row.version || '1.0',
      steps: Array.isArray(row.steps) ? row.steps : [],
      is_system,
      clinic_id,
      group_id,
      is_active: true,
    });

    return res.status(201).json({ success: true, data: mapTemplate(created) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Error duplicando plantilla', error: error.message });
  }
};
