const asyncHandler = require('express-async-handler');
const db = require('../../models');

const Campaign = db.Campaign;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;

const TYPES = new Set(['meta_ads', 'google_ads', 'web_snippet', 'local_services']);

exports.listCampaigns = asyncHandler(async (req, res) => {
  const { clinica_id, grupo_clinica_id, tipo, gestionada, activa } = req.query;

  const where = {};
  if (clinica_id) where.clinica_id = clinica_id;
  if (grupo_clinica_id) where.grupo_clinica_id = grupo_clinica_id;
  if (tipo && TYPES.has(tipo)) where.tipo = tipo;
  if (gestionada !== undefined) where.gestionada = gestionada === 'true' || gestionada === true;
  if (activa !== undefined) where.activa = activa === 'true' || activa === true;

  const campaigns = await Campaign.findAll({
    where,
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
      { model: GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'] }
    ],
    order: [['created_at', 'DESC']]
  });

  const items = campaigns.map((c) => {
    const totalLeads = c.total_leads || 0;
    const gasto = Number(c.gasto || 0);
    const cpl = totalLeads > 0 ? Number((gasto / totalLeads).toFixed(2)) : null;
    return { ...c.toJSON(), cpl };
  });

  res.status(200).json(items);
});

exports.createCampaign = asyncHandler(async (req, res) => {
  const {
    nombre,
    tipo,
    clinica_id,
    grupo_clinica_id,
    campaign_id_externo,
    gestionada,
    activa,
    fecha_inicio,
    fecha_fin,
    presupuesto
  } = req.body || {};

  if (!nombre || !tipo || !TYPES.has(tipo)) {
    return res.status(400).json({ message: 'nombre y tipo válidos son obligatorios' });
  }

  if (clinica_id) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinica_id } });
    if (!clinic) return res.status(400).json({ message: 'Clínica no encontrada' });
  }

  if (grupo_clinica_id) {
    const group = await GrupoClinica.findOne({ where: { id_grupo: grupo_clinica_id } });
    if (!group) return res.status(400).json({ message: 'Grupo no encontrado' });
  }

  const campaign = await Campaign.create({
    nombre,
    tipo,
    clinica_id: clinica_id || null,
    grupo_clinica_id: grupo_clinica_id || null,
    campaign_id_externo: campaign_id_externo || null,
    gestionada: gestionada === true || gestionada === 'true',
    activa: activa === false || activa === 'false' ? false : true,
    fecha_inicio: fecha_inicio || null,
    fecha_fin: fecha_fin || null,
    presupuesto: presupuesto || null
  });

  res.status(201).json(campaign);
});

exports.updateCampaign = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nombre, activa, gestionada, fecha_inicio, fecha_fin, presupuesto } = req.body || {};

  const campaign = await Campaign.findByPk(id);
  if (!campaign) {
    return res.status(404).json({ message: 'Campaña no encontrada' });
  }

  const payload = {};
  if (nombre !== undefined) payload.nombre = nombre;
  if (activa !== undefined) payload.activa = activa;
  if (gestionada !== undefined) payload.gestionada = gestionada;
  if (fecha_inicio !== undefined) payload.fecha_inicio = fecha_inicio;
  if (fecha_fin !== undefined) payload.fecha_fin = fecha_fin;
  if (presupuesto !== undefined) payload.presupuesto = presupuesto;

  await campaign.update(payload);

  const totalLeads = campaign.total_leads || 0;
  const gasto = Number(campaign.gasto || 0);
  const cpl = totalLeads > 0 ? Number((gasto / totalLeads).toFixed(2)) : null;

  res.status(200).json({ ...campaign.toJSON(), cpl });
});
