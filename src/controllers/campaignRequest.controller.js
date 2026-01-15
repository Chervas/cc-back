const asyncHandler = require('express-async-handler');
const db = require('../../models');

const CampaignRequest = db.CampaignRequest;
const Campaign = db.Campaign;
const Clinica = db.Clinica;

exports.createRequest = asyncHandler(async (req, res) => {
  const { clinica_id, campaign_id, estado, solicitud } = req.body || {};

  if (clinica_id) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinica_id } });
    if (!clinic) return res.status(400).json({ message: 'Clínica no encontrada' });
  }

  if (campaign_id) {
    const camp = await Campaign.findByPk(campaign_id);
    if (!camp) return res.status(400).json({ message: 'Campaña no encontrada' });
  }

  const request = await CampaignRequest.create({
    clinica_id: clinica_id || null,
    campaign_id: campaign_id || null,
    estado: estado || 'pendiente_aceptacion',
    solicitud: solicitud || null
  });

  res.status(201).json(request);
});

exports.listRequests = asyncHandler(async (req, res) => {
  const { clinica_id, estado } = req.query;
  const where = {};
  if (clinica_id) where.clinica_id = clinica_id;
  if (estado) where.estado = estado;

  const requests = await CampaignRequest.findAll({
    where,
    include: [
      { model: Campaign, as: 'campaign', attributes: ['id', 'nombre', 'tipo'] },
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] }
    ],
    order: [['created_at', 'DESC']]
  });

  res.status(200).json(requests);
});
