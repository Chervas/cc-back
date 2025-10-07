'use strict';
const { Op } = require('sequelize');
const { GrupoClinica, ClinicMetaAsset, ClinicGoogleAdsAccount, Clinica } = require('../../models');
const { metaSyncJobs } = require('../jobs/sync.jobs');

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
    console.log("Actualizando grupo con ID:", req.params.id);
    const group = await GrupoClinica.findByPk(req.params.id);
    if (!group) {
      console.log("Grupo no encontrado");
      return res.status(404).json({ message: 'Group not found' });
    }
    const {
      nombre_grupo,
      ads_assignment_mode,
      ads_assignment_delimiter,
      web_assignment_mode,
      web_primary_url
    } = req.body;

    const previousAdsMode = group.ads_assignment_mode;

    if (typeof nombre_grupo === 'string' && nombre_grupo.trim().length) {
      group.nombre_grupo = nombre_grupo.trim();
    }
    if (ads_assignment_mode && ['manual', 'automatic'].includes(ads_assignment_mode)) {
      group.ads_assignment_mode = ads_assignment_mode;
    }
    if (typeof ads_assignment_delimiter === 'string' && ads_assignment_delimiter.trim().length) {
      group.ads_assignment_delimiter = ads_assignment_delimiter.trim();
    }
    if (web_assignment_mode && ['manual', 'automatic'].includes(web_assignment_mode)) {
      group.web_assignment_mode = web_assignment_mode;
    }
    if (typeof web_primary_url === 'string') {
      group.web_primary_url = web_primary_url.trim() || null;
    }

    await group.save();
    console.log("Grupo actualizado:", group);

    const adsModeChanged = previousAdsMode !== group.ads_assignment_mode;

    if (adsModeChanged) {
      try {
        const clinics = await Clinica.findAll({
          where: { grupoClinicaId: group.id_grupo },
          attributes: ['id_clinica']
        });

        const clinicIds = Array.from(new Set(clinics.map(c => Number(c.id_clinica)).filter(Number.isInteger)));

        if (clinicIds.length) {
          if (group.ads_assignment_mode === 'automatic') {
            await ClinicMetaAsset.update({
              assignmentScope: 'group',
              grupoClinicaId: group.id_grupo
            }, {
              where: {
                clinicaId: { [Op.in]: clinicIds },
                assetType: 'ad_account'
              }
            });

            await ClinicGoogleAdsAccount.update({
              assignmentScope: 'group',
              grupoClinicaId: group.id_grupo
            }, {
              where: {
                clinicaId: { [Op.in]: clinicIds }
              }
            });

            setImmediate(() => {
              metaSyncJobs.executeAdsSync({ clinicIds })
                .catch(err => console.error('❌ Error en resync Meta Ads tras cambio de modo de grupo:', err.message));
            });

            setImmediate(() => {
              metaSyncJobs.executeGoogleAdsSync({ clinicIds })
                .catch(err => console.error('❌ Error en resync Google Ads tras cambio de modo de grupo:', err.message));
            });
          } else {
            await ClinicMetaAsset.update({
              assignmentScope: 'clinic',
              grupoClinicaId: null
            }, {
              where: {
                clinicaId: { [Op.in]: clinicIds },
                assetType: 'ad_account'
              }
            });

            await ClinicGoogleAdsAccount.update({
              assignmentScope: 'clinic',
              grupoClinicaId: null
            }, {
              where: {
                clinicaId: { [Op.in]: clinicIds }
              }
            });
          }
        }
      } catch (assignmentErr) {
        console.error('❌ Error actualizando asignaciones tras cambio de modo del grupo:', assignmentErr);
      }
    }

    res.json(group);
  } catch (error) {
    console.error("Error updating group:", error);
    res.status(500).json({ message: 'Error updating group', error: error.message });
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

    const group = await GrupoClinica.findByPk(groupId, {
      include: [{ model: Clinica, as: 'clinicas', attributes: ['id_clinica', 'nombre_clinica'] }]
    });

    if (!group) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const plainGroup = group.get ? group.get({ plain: true }) : group;

    const metaAdsAccounts = await ClinicMetaAsset.findAll({
      where: { grupoClinicaId: groupId, assetType: 'ad_account', isActive: true },
      attributes: ['id', 'metaAssetId', 'metaAssetName', 'assignmentScope', 'clinicaId', 'grupoClinicaId']
    });

    const googleAdsAccounts = await ClinicGoogleAdsAccount.findAll({
      where: { grupoClinicaId: groupId, isActive: true },
      attributes: ['id', 'customerId', 'descriptiveName', 'assignmentScope', 'clinicaId', 'grupoClinicaId']
    });

    return res.json({
      id: plainGroup.id_grupo,
      nombre: plainGroup.nombre_grupo,
      adsAssignmentMode: plainGroup.ads_assignment_mode,
      adsAssignmentDelimiter: plainGroup.ads_assignment_delimiter,
      webAssignmentMode: plainGroup.web_assignment_mode,
      webPrimaryUrl: plainGroup.web_primary_url,
      clinics: (plainGroup.clinicas || []).map(c => ({ id: c.id_clinica, nombre: c.nombre_clinica })),
      metaAdsAccounts,
      googleAdsAccounts
    });
  } catch (error) {
    console.error('Error retrieving group ads configuration:', error);
    res.status(500).json({ message: 'Error retrieving group ads configuration', error: error.message });
  }
};
