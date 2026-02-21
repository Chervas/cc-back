'use strict';
const { Op } = require('sequelize');
const { GrupoClinica, Clinica, UsuarioClinica } = require('../../models');
const { metaSyncJobs } = require('../jobs/sync.jobs');
const groupAssetsService = require('../services/groupAssets.service');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const { STAFF_ROLES, ADMIN_ROLES, isGlobalAdmin } = require('../lib/role-helpers');

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
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) {
      return res.status(400).json({ message: 'ID de grupo inválido' });
    }

    const group = await GrupoClinica.findByPk(groupId);
    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const updated = await groupAssetsService.updateGroupConfig(groupId, payload);

    // Re-sincronizar Ads cuando corresponda (manteniendo comportamiento previo)
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica']
    });
    const clinicIds = Array.from(new Set(clinics.map(c => Number(c.id_clinica)).filter(Number.isInteger)));

    if (clinicIds.length && payload.ads && payload.ads.mode) {
      const metaJob = await jobRequestsService.enqueueJobRequest({
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

      const googleJob = await jobRequestsService.enqueueJobRequest({
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
    const group = await GrupoClinica.findByPk(req.params.id);
    if (!group) {
      console.log("Grupo no encontrado");
      return res.status(404).json({ message: 'Group not found' });
    }
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
    const groupId = parseInt(req.params.id, 10);
    if (!Number.isInteger(groupId)) {
      return res.status(400).json({ message: 'ID de grupo inválido' });
    }

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
