'use strict';
const { Op } = require('sequelize');
const { GrupoClinica, Clinica, UsuarioClinica } = require('../../models');
const { metaSyncJobs } = require('../jobs/sync.jobs');
const groupAssetsService = require('../services/groupAssets.service');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const {
  STAFF_ROLES,
  ADMIN_ROLES,
  MARKETING_WRITE_ROLES,
  isGlobalAdmin,
} = require('../lib/role-helpers');

const ACTIVE_STAFF_INVITATION_WHERE = {
  [Op.or]: [
    { estado_invitacion: 'aceptada' },
    { estado_invitacion: null },
  ],
};

async function getScopedGroupIdsForUser(userId) {
  if (isGlobalAdmin(userId)) {
    return null;
  }

  const memberships = await UsuarioClinica.findAll({
    where: {
      id_usuario: Number(userId),
      rol_clinica: { [Op.in]: STAFF_ROLES },
      ...ACTIVE_STAFF_INVITATION_WHERE,
    },
    attributes: ['id_clinica'],
    include: [
      {
        model: Clinica,
        as: 'Clinica',
        attributes: ['grupoClinicaId'],
      },
    ],
  });

  const groupIds = memberships
    .map((row) => Number(row?.Clinica?.grupoClinicaId))
    .filter((id) => Number.isFinite(id) && id > 0);

  return Array.from(new Set(groupIds));
}

async function getManageableClinicIdsForUser(userId) {
  if (isGlobalAdmin(userId)) {
    return null;
  }

  const memberships = await UsuarioClinica.findAll({
    where: {
      id_usuario: Number(userId),
      rol_clinica: { [Op.in]: ADMIN_ROLES },
      ...ACTIVE_STAFF_INVITATION_WHERE,
    },
    attributes: ['id_clinica'],
    raw: true,
  });

  const clinicIds = memberships
    .map((row) => Number(row.id_clinica))
    .filter((id) => Number.isFinite(id) && id > 0);

  return Array.from(new Set(clinicIds));
}

const GROUP_AGENCY_WRITE_KEYS = new Set(['ads', 'adsAccounts']);

function parseGroupId(value) {
  const id = Number.parseInt(String(value), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function requestedGroupClinicIds(payload = {}) {
  const values = payload?.clinics?.clinicIds;
  if (!Array.isArray(values)) return null;
  return Array.from(new Set(values
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function isAgencyMarketingOnlyPayload(payload = {}) {
  const keys = Object.keys(payload && typeof payload === 'object' ? payload : {});
  return keys.length > 0 && keys.every((key) => GROUP_AGENCY_WRITE_KEYS.has(key));
}

async function getGroupClinicIds(groupId) {
  const rows = await Clinica.findAll({
    where: { grupoClinicaId: Number(groupId) },
    attributes: ['id_clinica'],
    raw: true,
  });
  return Array.from(new Set(rows
    .map((row) => Number(row.id_clinica))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

async function getMembershipsForClinics(userId, clinicIds, roles = STAFF_ROLES) {
  const ids = Array.from(new Set((clinicIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)));
  if (!ids.length) return [];
  return UsuarioClinica.findAll({
    where: {
      id_usuario: Number(userId),
      id_clinica: { [Op.in]: ids },
      rol_clinica: { [Op.in]: roles },
      ...ACTIVE_STAFF_INVITATION_WHERE,
    },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });
}

async function resolveGroupResourceAccess(userId, groupId, payload = null) {
  const actorId = Number(userId);
  const normalizedGroupId = parseGroupId(groupId);
  if (!Number.isFinite(actorId) || !normalizedGroupId) {
    return {
      read: false,
      ownerWrite: false,
      marketingWrite: false,
      targetClinicsOwned: false,
      clinicIds: [],
    };
  }
  if (isGlobalAdmin(actorId)) {
    return {
      read: true,
      ownerWrite: true,
      marketingWrite: true,
      targetClinicsOwned: true,
      clinicIds: await getGroupClinicIds(normalizedGroupId),
    };
  }

  const clinicIds = await getGroupClinicIds(normalizedGroupId);
  const memberships = await getMembershipsForClinics(actorId, clinicIds);
  const ownerClinicIds = new Set(memberships
    .filter((row) => ADMIN_ROLES.includes(row.rol_clinica))
    .map((row) => Number(row.id_clinica)));
  const marketingClinicIds = new Set(memberships
    .filter((row) => MARKETING_WRITE_ROLES.includes(row.rol_clinica))
    .map((row) => Number(row.id_clinica)));
  const targetClinicIds = requestedGroupClinicIds(payload);
  let targetClinicsOwned = false;
  if (targetClinicIds !== null) {
    const ownerMemberships = await getMembershipsForClinics(actorId, targetClinicIds, ADMIN_ROLES);
    const ownedIds = new Set(ownerMemberships.map((row) => Number(row.id_clinica)));
    targetClinicsOwned = targetClinicIds.every((id) => ownedIds.has(id));
  }

  return {
    read: memberships.length > 0,
    ownerWrite: clinicIds.length > 0 && clinicIds.every((id) => ownerClinicIds.has(id)),
    marketingWrite: clinicIds.length > 0 && clinicIds.every((id) => marketingClinicIds.has(id)),
    targetClinicsOwned,
    clinicIds,
  };
}

function sendGroupScopeForbidden(res) {
  return res.status(403).json({ message: 'Forbidden', error: 'group_scope_forbidden' });
}

async function ensureGroupReadAccess(req, res, groupId) {
  const access = await resolveGroupResourceAccess(req.userData?.userId, groupId);
  if (access.read) return access;
  sendGroupScopeForbidden(res);
  return null;
}

async function ensureGroupWriteAccess(req, res, groupId, payload) {
  const access = await resolveGroupResourceAccess(req.userData?.userId, groupId, payload);
  if (access.ownerWrite) {
    const targetClinicIds = requestedGroupClinicIds(payload);
    if (targetClinicIds === null || access.targetClinicsOwned) return access;
  }
  if (access.clinicIds.length === 0
      && access.targetClinicsOwned
      && requestedGroupClinicIds(payload) !== null) {
    const keys = Object.keys(payload && typeof payload === 'object' ? payload : {});
    if (keys.length === 1 && keys[0] === 'clinics') return access;
  }
  if (access.marketingWrite && isAgencyMarketingOnlyPayload(payload)) return access;
  sendGroupScopeForbidden(res);
  return null;
}

exports.getAllGroups = async (req, res) => {
  try {
    console.log("Obteniendo todos los grupos de clínicas");
    const userId = Number(req.userData?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ message: 'No autenticado' });
    }

    const scopedGroupIds = await getScopedGroupIdsForUser(userId);
    const where = Array.isArray(scopedGroupIds) ? { id_grupo: { [Op.in]: scopedGroupIds } } : undefined;
    const grupos = await GrupoClinica.findAll({
      where,
      order: [['nombre_grupo', 'ASC']],
    });
    console.log("Grupos recuperados:", grupos);
    res.json(grupos);
  } catch (error) {
    console.error("Error retrieving groups:", error);
    res.status(500).json({ message: 'Error retrieving groups', error: error.message });
  }
};

exports.createGroup = async (req, res) => {
  try {
    console.log("Creando nuevo grupo con datos:", req.body);
    const userId = Number(req.userData?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ message: 'No autenticado' });
    }

    if (!isGlobalAdmin(userId)) {
      const manageableClinicIds = await getManageableClinicIdsForUser(userId);
      if (!Array.isArray(manageableClinicIds) || manageableClinicIds.length < 2) {
        return res.status(403).json({
          message: 'Necesitas al menos 2 clínicas en tu ámbito para crear grupos.',
          error: 'GROUP_CREATE_SCOPE_TOO_SMALL',
        });
      }
    }

    const nombreGrupo = String(req.body?.nombre_grupo || '').trim();
    const nombre_grupo = nombreGrupo || 'Nuevo grupo';
    const newGroup = await GrupoClinica.create({ nombre_grupo });
    console.log("Grupo creado exitosamente:", newGroup);
    res.status(201).json(newGroup);
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({ message: 'Error creating group', error: error.message });
  }
};

exports.updateGroup = async (req, res) => {
  try {
    const userId = Number(req.userData?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ message: 'No autenticado' });
    }
    const groupId = parseGroupId(req.params.id);
    if (!groupId) {
      return res.status(400).json({ message: 'ID de grupo inválido' });
    }

    const group = await GrupoClinica.findByPk(groupId);
    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    if (!(await ensureGroupWriteAccess(req, res, groupId, payload))) return;
    const updated = await groupAssetsService.updateGroupConfig(groupId, payload);

    // Re-sincronizar Ads cuando corresponda (manteniendo comportamiento previo)
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica']
    });
    const clinicIds = Array.from(new Set(clinics.map(c => Number(c.id_clinica)).filter(Number.isInteger)));

    if (clinicIds.length && payload.ads && payload.ads.mode) {
      const { job: metaJob } = await jobRequestsService.enqueueUniqueJobRequest({
        type: 'meta_ads_recent',
        payload: { clinicIds },
        priority: 'high',
        origin: 'group:update',
        requestedBy: req.userData?.userId || null,
        requestedByRole: req.userData?.role || null,
        requestedByName: req.userData?.name || null
      });
      jobScheduler.triggerImmediate(metaJob.id).catch((err) =>
        console.error('❌ Error en resync Meta Ads tras actualizar grupo:', err)
      );

      const { job: googleJob } = await jobRequestsService.enqueueUniqueJobRequest({
        type: 'google_ads_recent',
        payload: { clinicIds },
        priority: 'high',
        origin: 'group:update',
        requestedBy: req.userData?.userId || null,
        requestedByRole: req.userData?.role || null,
        requestedByName: req.userData?.name || null
      });
      jobScheduler.triggerImmediate(googleJob.id).catch((err) =>
        console.error('❌ Error en resync Google Ads tras actualizar grupo:', err)
      );
    }

    return res.json(updated);
  } catch (error) {
    console.error("Error updating group:", error);
    return res.status(500).json({ message: 'Error updating group', error: error.message });
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    console.log("Eliminando grupo con ID:", req.params.id);
    const userId = Number(req.userData?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ message: 'No autenticado' });
    }
    const groupId = parseGroupId(req.params.id);
    if (!groupId) {
      return res.status(400).json({ message: 'ID de grupo inválido' });
    }
    const group = await GrupoClinica.findByPk(groupId);
    if (!group) {
      console.log("Grupo no encontrado");
      return res.status(404).json({ message: 'Group not found' });
    }
    const access = await resolveGroupResourceAccess(userId, groupId);
    if (!access.ownerWrite) return sendGroupScopeForbidden(res);
    await group.destroy();
    console.log("Grupo eliminado");
    res.json({ message: 'Group deleted' });
  } catch (error) {
    console.error("Error deleting group:", error);
    res.status(500).json({ message: 'Error deleting group', error: error.message });
  }
};

exports.getAdsConfig = async (req, res) => {
  try {
    const userId = Number(req.userData?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(401).json({ message: 'No autenticado' });
    }
    const groupId = parseGroupId(req.params.id);
    if (!groupId) {
      return res.status(400).json({ message: 'ID de grupo inválido' });
    }

    if (!(await ensureGroupReadAccess(req, res, groupId))) return;
    const config = await groupAssetsService.getGroupConfig(groupId);
    if (!config) {
      return res.status(404).json({ message: 'Group not found' });
    }

    return res.json(config);
  } catch (error) {
    console.error('Error retrieving group configuration:', error);
    res.status(500).json({ message: 'Error retrieving group configuration', error: error.message });
  }
};

exports.__groupResourceAccessContract = Object.freeze({
  isAgencyMarketingOnlyPayload,
  requestedGroupClinicIds,
  resolveGroupResourceAccess,
});
