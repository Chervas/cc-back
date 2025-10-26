'use strict';
const { GrupoClinica, Clinica } = require('../../models');
const { metaSyncJobs } = require('../jobs/sync.jobs');
const groupAssetsService = require('../services/groupAssets.service');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');

exports.getAllGroups = async (req, res) => {
  try {
    console.log("Obteniendo todos los grupos de clínicas");
    const grupos = await GrupoClinica.findAll({ order: [['nombre_grupo', 'ASC']] });
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
    const { nombre_grupo } = req.body;
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
