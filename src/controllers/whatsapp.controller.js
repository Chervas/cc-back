'use strict';
const db = require('../../models');
const { Op } = require('sequelize');

const {
  ClinicMetaAsset,
  UsuarioClinica,
  Clinica,
  WhatsappTemplate,
  MetaConnection,
  GrupoClinica,
  WhatsappTemplateCatalog,
  WhatsappTemplateCatalogDiscipline,
} = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1').split(',').map((v) => parseInt(v.trim(), 10)).filter((n) => !Number.isNaN(n));

async function getUserClinics(userId) {
  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });
  const clinicIds = memberships.map((m) => m.id_clinica);
  const roles = memberships.map((m) => m.rol_clinica);
  const isAggregateAllowed = roles.some((r) => ROLE_AGGREGATE.includes(r));
  return { clinicIds, isAggregateAllowed };
}

function assertAdmin(req, res) {
  const uid = Number(req.userData?.userId);
  if (!uid || !ADMIN_USER_IDS.includes(uid)) {
    res.status(403).json({ error: 'admin_only' });
    return false;
  }
  return true;
}

exports.getStatus = async (req, res) => {
  try {
    const clinicId = Number(req.query.clinic_id);
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id requerido' });
    }

    const asset = await ClinicMetaAsset.findOne({
      where: {
        clinicaId: clinicId,
        isActive: true,
        assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
      },
      raw: true,
    });

    if (!asset) {
      return res.json({ configured: false });
    }

    return res.json({
      configured: true,
      wabaId: asset.wabaId || null,
      phoneNumberId: asset.phoneNumberId || null,
      waVerifiedName: asset.waVerifiedName || null,
      quality_rating: asset.quality_rating || null,
      messaging_limit: asset.messaging_limit || null,
      phoneNumber: asset.metaAssetName || null,
    });
  } catch (err) {
    console.error('Error getStatus', err);
    return res.status(500).json({ error: 'Error obteniendo estado de WhatsApp' });
  }
};

exports.listAccounts = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const where = {
      isActive: true,
      assetType: 'whatsapp_phone_number',
    };
    if (!isAggregateAllowed) {
      where[Op.or] = [
        { clinicaId: { [Op.in]: clinicIds } },
        { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
      ];
    }
    const assets = await ClinicMetaAsset.findAll({
      where,
      include: [
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
      ],
      raw: true,
    });

    const payload = assets.map((a) => ({
      clinic_id: a.clinicaId,
      clinic_name: a['clinica.nombre_clinica'] || null,
      wabaId: a.wabaId || null,
      phoneNumberId: a.phoneNumberId || null,
      waVerifiedName: a.waVerifiedName || null,
      quality_rating: a.quality_rating || null,
      messaging_limit: a.messaging_limit || null,
      assignmentScope: a.assignmentScope || 'clinic',
    }));
    return res.json(payload);
  } catch (err) {
    console.error('Error listAccounts', err);
    return res.status(500).json({ error: 'Error obteniendo cuentas WhatsApp' });
  }
};

exports.templatesSummary = async (req, res) => {
  try {
    const clinicId = Number(req.query.clinic_id);
    if (!clinicId) {
      return res.status(400).json({ error: 'clinic_id requerido' });
    }
    const asset = await ClinicMetaAsset.findOne({
      where: {
        clinicaId: clinicId,
        isActive: true,
        assetType: { [Op.in]: ['whatsapp_business_account', 'whatsapp_phone_number'] },
      },
      raw: true,
    });
    if (!asset?.wabaId) {
      return res.json({ total: 0, approved: 0, pending: 0, rejected: 0 });
    }
    const wabaId = asset.wabaId;
    const totals = await WhatsappTemplate.findAll({
      where: { waba_id: wabaId },
      attributes: ['status', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'count']],
      group: ['status'],
      raw: true,
    });
    const summary = { total: 0, approved: 0, pending: 0, rejected: 0 };
    totals.forEach((row) => {
      summary.total += Number(row.count);
      const st = (row.status || '').toLowerCase();
      if (st === 'approved' || st === 'approved_pending') summary.approved += Number(row.count);
      else if (st === 'pending' || st === 'in_review') summary.pending += Number(row.count);
      else if (st === 'rejected') summary.rejected += Number(row.count);
    });
    return res.json(summary);
  } catch (err) {
    console.error('Error templatesSummary', err);
    return res.status(500).json({ error: 'Error obteniendo resumen de plantillas' });
  }
};

async function resolveWabaFromContext({ clinicId, phoneNumberId, userId }) {
  const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
  const where = {
    isActive: true,
    assetType: { [Op.in]: ['whatsapp_phone_number', 'whatsapp_business_account'] },
  };

  if (clinicId) {
    where.clinicaId = clinicId;
  }
  if (phoneNumberId) {
    where.phoneNumberId = phoneNumberId;
  }

  // Restricción por permisos si no es agregador
  if (!isAggregateAllowed) {
    where[Op.or] = [
      { clinicaId: { [Op.in]: clinicIds } },
      { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
    ];
  }

  const asset = await ClinicMetaAsset.findOne({
    where,
    include: [{ model: MetaConnection, as: 'metaConnection', attributes: ['userId'] }],
    order: [['updatedAt', 'DESC']],
  });

  return asset;
}

exports.listTemplatesForClinic = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId) {
      return res.json([]);
    }

    const templates = await WhatsappTemplate.findAll({
      where: {
        waba_id: asset.wabaId,
        is_active: true,
      },
      order: [['name', 'ASC']],
    });

    return res.json(templates);
  } catch (err) {
    console.error('Error listTemplatesForClinic', err);
    return res.status(500).json({ error: 'Error obteniendo plantillas' });
  }
};

exports.syncTemplates = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId || !asset.waAccessToken) {
      return res.status(404).json({ error: 'waba_not_found' });
    }

    const { enqueueSyncTemplatesJob } = require('../services/whatsappTemplates.service');
    const job = await enqueueSyncTemplatesJob({ wabaId: asset.wabaId, accessToken: asset.waAccessToken });
    return res.json({ success: true, jobId: job?.id || null });
  } catch (err) {
    console.error('Error syncTemplates', err);
    return res.status(500).json({ error: 'Error sincronizando plantillas' });
  }
};

exports.createTemplatesFromCatalog = async (req, res) => {
  try {
    const clinicId = req.query.clinic_id ? Number(req.query.clinic_id) : null;
    const phoneNumberId = req.query.phone_number_id || null;
    const userId = req.userData?.userId;

    if (!clinicId && !phoneNumberId) {
      return res.status(400).json({ error: 'clinic_id o phone_number_id requerido' });
    }

    const asset = await resolveWabaFromContext({ clinicId, phoneNumberId, userId });
    if (!asset || !asset.wabaId) {
      return res.status(404).json({ error: 'waba_not_found' });
    }

    const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
    const job = await enqueueCreateTemplatesJob({
      wabaId: asset.wabaId,
      clinicId: asset.clinicaId || null,
      groupId: asset.grupoClinicaId || null,
      assignmentScope: asset.assignmentScope || 'clinic',
    });
    return res.json({ success: true, jobId: job?.id || null });
  } catch (err) {
    console.error('Error createTemplatesFromCatalog', err);
    return res.status(500).json({ error: 'Error creando plantillas' });
  }
};

exports.listPhones = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);

    const where = {
      isActive: true,
      assetType: 'whatsapp_phone_number',
    };

    if (!isAggregateAllowed) {
      where[Op.or] = [
        { clinicaId: { [Op.in]: clinicIds } },
        { assignmentScope: 'unassigned', '$metaConnection.userId$': userId },
      ];
    }

    const phones = await ClinicMetaAsset.findAll({
      where,
      include: [
        { 
          model: Clinica, 
          as: 'clinica', 
          attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'grupoClinicaId'],
          include: [{
            model: GrupoClinica,
            as: 'grupoClinica',
            attributes: ['id_grupo', 'nombre_grupo']
          }]
        },
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    const payload = phones.map((p) => {
      const clinica = p.clinica || {};
      const grupo = clinica.grupoClinica || {};
      return {
        id: p.id,
        phoneNumberId: p.phoneNumberId,
        wabaId: p.wabaId,
        phoneNumber: p.metaAssetName || null,
        waVerifiedName: p.waVerifiedName || null,
        quality_rating: p.quality_rating || null,
        messaging_limit: p.messaging_limit || null,
        assignmentScope: p.assignmentScope,
        clinic_id: p.clinicaId || null,
        clinic_name: clinica.nombre_clinica || null,
        clinic_avatar: clinica.url_avatar || null,
        group_id: grupo.id_grupo || clinica.grupoClinicaId || null,
        group_name: grupo.nombre_grupo || null,
        createdAt: p.createdAt,
      };
    });

    return res.json({ phones: payload });
  } catch (err) {
    console.error('Error listPhones', err);
    return res.status(500).json({ error: 'Error obteniendo números WhatsApp' });
  }
};

// =======================
// Catálogo de plantillas
// =======================

exports.listCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const items = await WhatsappTemplateCatalog.findAll({
      include: [
        {
          model: WhatsappTemplateCatalogDiscipline,
          as: 'disciplinas',
          attributes: ['id', 'disciplina_code'],
        },
      ],
      order: [['name', 'ASC']],
    });
    return res.json(items);
  } catch (err) {
    console.error('Error listCatalog', err);
    return res.status(500).json({ error: 'Error obteniendo catálogo' });
  }
};

exports.createCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const { name, display_name, category, body_text, variables, components, is_generic = false, is_active = true } = req.body || {};
    if (!name || !category || !body_text) {
      return res.status(400).json({ error: 'name, category y body_text son obligatorios' });
    }
    const item = await WhatsappTemplateCatalog.create({
      name,
      display_name: display_name || null,
      category,
      body_text,
      variables: variables || null,
      components: components || null,
      is_generic: !!is_generic,
      is_active: !!is_active,
    });
    return res.status(201).json(item);
  } catch (err) {
    console.error('Error createCatalog', err);
    return res.status(500).json({ error: 'Error creando catálogo' });
  }
};

exports.updateCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const { display_name, category, body_text, variables, components, is_generic, is_active, name } = req.body || {};
    await item.update({
      name: name || item.name,
      display_name: display_name !== undefined ? display_name : item.display_name,
      category: category || item.category,
      body_text: body_text || item.body_text,
      variables: variables !== undefined ? variables : item.variables,
      components: components !== undefined ? components : item.components,
      is_generic: is_generic !== undefined ? !!is_generic : item.is_generic,
      is_active: is_active !== undefined ? !!is_active : item.is_active,
    });
    return res.json(item);
  } catch (err) {
    console.error('Error updateCatalog', err);
    return res.status(500).json({ error: 'Error actualizando catálogo' });
  }
};

exports.deleteCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const inUse = await WhatsappTemplate.count({ where: { catalog_template_id: id } });
    if (inUse > 0) {
      return res.status(400).json({ error: 'catalog_in_use' });
    }
    await WhatsappTemplateCatalog.destroy({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error('Error deleteCatalog', err);
    return res.status(500).json({ error: 'Error eliminando catálogo' });
  }
};

exports.toggleCatalog = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });
    const newState = req.body?.is_active;
    if (newState === undefined) {
      item.is_active = !item.is_active;
    } else {
      item.is_active = !!newState;
    }
    await item.save();
    return res.json(item);
  } catch (err) {
    console.error('Error toggleCatalog', err);
    return res.status(500).json({ error: 'Error actualizando estado' });
  }
};

exports.setCatalogDisciplines = async (req, res) => {
  if (!assertAdmin(req, res)) return;
  try {
    const id = Number(req.params.id);
    const item = await WhatsappTemplateCatalog.findByPk(id);
    if (!item) return res.status(404).json({ error: 'catalog_not_found' });

    const disciplinaCodes = Array.isArray(req.body?.disciplina_codes) ? req.body.disciplina_codes : [];
    await WhatsappTemplateCatalogDiscipline.destroy({ where: { template_catalog_id: id } });

    if (disciplinaCodes.length) {
      const rows = disciplinaCodes.map((code) => ({
        template_catalog_id: id,
        disciplina_code: code,
        created_at: new Date(),
        updated_at: new Date(),
      }));
      await WhatsappTemplateCatalogDiscipline.bulkCreate(rows);
    }
    const updated = await WhatsappTemplateCatalog.findByPk(id, {
      include: [{ model: WhatsappTemplateCatalogDiscipline, as: 'disciplinas', attributes: ['id', 'disciplina_code'] }],
    });
    return res.json(updated);
  } catch (err) {
    console.error('Error setCatalogDisciplines', err);
    return res.status(500).json({ error: 'Error actualizando disciplinas' });
  }
};

exports.assignPhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    const { assignmentScope, clinic_id } = req.body || {};

    if (!['group', 'clinic'].includes(assignmentScope)) {
      return res.status(400).json({ success: false, error: 'invalid_assignment_scope' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId: phoneNumberId,
        isActive: true,
      },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        // Ajustar a columna grupoClinicaId (no id_grupo)
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const isOwner = phone.metaConnection?.userId === userId;
    const canManage =
      isOwner ||
      isAggregateAllowed ||
      (phone.clinicaId && clinicIds.includes(phone.clinicaId)) ||
      assignmentScope === 'clinic';

    if (!canManage) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    let targetClinicId = null;
    let targetGroupId = null;

    if (assignmentScope === 'clinic') {
      if (!clinic_id) {
        return res.status(400).json({ success: false, error: 'clinic_id_required' });
      }
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinic_id },
        attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        raw: true,
      });
      if (!clinic) {
        return res.status(404).json({ success: false, error: 'invalid_clinic' });
      }
      if (!isAggregateAllowed && !clinicIds.includes(clinic_id)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      targetClinicId = clinic_id;
      targetGroupId = clinic.grupoClinicaId || null;
    } else if (assignmentScope === 'group') {
      if (!clinic_id) {
        return res.status(400).json({ success: false, error: 'clinic_id_required_for_group' });
      }
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinic_id },
        attributes: ['grupoClinicaId'],
        raw: true,
      });
      if (!clinic) {
        return res.status(404).json({ success: false, error: 'invalid_clinic' });
      }
      if (!isAggregateAllowed && !clinicIds.includes(clinic_id)) {
        return res.status(403).json({ success: false, error: 'forbidden' });
      }
      targetGroupId = clinic.grupoClinicaId || null;
    }

    await phone.update({
      assignmentScope,
      clinicaId: targetClinicId,
      grupoClinicaId: targetGroupId,
    });

    // Encolar creación automática de plantillas al asignar
    const { enqueueCreateTemplatesJob } = require('../services/whatsappTemplates.service');
    if (phone.wabaId && assignmentScope !== 'unassigned') {
      enqueueCreateTemplatesJob({
        wabaId: phone.wabaId,
        clinicId: targetClinicId,
        groupId: targetGroupId,
        assignmentScope,
      }).catch((err) => {
        console.error('Error encolando plantillas al asignar número', err?.message || err);
      });
    }

    return res.json({
      success: true,
      phoneNumberId,
      assignmentScope,
      clinic_id: targetClinicId,
      clinic_name: phone.clinica?.nombre_clinica || null,
    });
  } catch (err) {
    console.error('Error assignPhone', err);
    return res.status(500).json({ success: false, error: 'assign_failed' });
  }
};

exports.deletePhone = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const phoneNumberId = req.params.phoneNumberId;
    if (!phoneNumberId) {
      return res.status(400).json({ success: false, error: 'phone_number_id_required' });
    }

    const phone = await ClinicMetaAsset.findOne({
      where: { assetType: 'whatsapp_phone_number', phoneNumberId, isActive: true },
      include: [
        { model: MetaConnection, as: 'metaConnection', attributes: ['userId'] },
        { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'] },
      ],
    });

    if (!phone) {
      return res.status(404).json({ success: false, error: 'phone_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const isOwner = phone.metaConnection?.userId === userId;
    const hasClinicAccess = phone.clinicaId ? clinicIds.includes(phone.clinicaId) : false;
    const canManage = isOwner || isAggregateAllowed || hasClinicAccess;
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    await phone.update({
      isActive: false,
      assignmentScope: 'unassigned',
      clinicaId: null,
      grupoClinicaId: null,
    });

    if (phone.wabaId) {
      await ClinicMetaAsset.update(
        {
          isActive: false,
          assignmentScope: 'unassigned',
          clinicaId: null,
          grupoClinicaId: null,
        },
        { where: { assetType: 'whatsapp_business_account', wabaId: phone.wabaId } }
      );
    }

    return res.json({ success: true, phoneNumberId });
  } catch (err) {
    console.error('Error deletePhone', err);
    return res.status(500).json({ success: false, error: 'delete_failed' });
  }
};
