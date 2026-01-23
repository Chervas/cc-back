'use strict';
const db = require('../../models');
const { Op } = require('sequelize');

const { ClinicMetaAsset, UsuarioClinica, Clinica, WhatsappTemplate } = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];

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
      where.clinicaId = { [Op.in]: clinicIds };
    }
    const assets = await ClinicMetaAsset.findAll({
      where,
      include: [{ model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] }],
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
