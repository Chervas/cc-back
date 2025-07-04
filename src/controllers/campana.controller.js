const db = require('../../models');
const Campana = db.Campana;
const Clinica = db.Clinica;
const asyncHandler = require('express-async-handler');

// Obtener todas las campañas
const getAllCampanas = asyncHandler(async (req, res) => {
  const campanas = await Campana.findAll({
    include: [{
      model: Clinica,
      as: 'clinica',
      attributes: ['id', 'nombre']
    }]
  });
  
  res.status(200).json(campanas);
});

// Obtener una campaña por ID
const getCampanaById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const campana = await Campana.findByPk(id, {
    include: [{
      model: Clinica,
      as: 'clinica',
      attributes: ['id', 'nombre']
    }]
  });
  
  if (!campana) {
    res.status(404);
    throw new Error('Campaña no encontrada');
  }
  
  res.status(200).json(campana);
});

// Crear una nueva campaña
const createCampana = asyncHandler(async (req, res) => {
  const { 
    nombre, 
    campaign_id, 
    estado, 
    gastoTotal, 
    fechaInicio, 
    fechaFin, 
    leads, 
    preset, 
    frecuenciaMaxima, 
    reproducciones75, 
    reproduccionesTotales, 
    curvaVisionado, 
    orden, 
    precioPorLead, 
    mostrar,
    clinica_id 
  } = req.body;
  
  // Verificar si la clínica existe
  if (clinica_id) {
    const clinica = await Clinica.findByPk(clinica_id);
    if (!clinica) {
      res.status(404);
      throw new Error('Clínica no encontrada');
    }
  }
  
  const campana = await Campana.create({
    nombre, 
    campaign_id, 
    estado, 
    gastoTotal, 
    fechaInicio, 
    fechaFin, 
    leads, 
    preset, 
    frecuenciaMaxima, 
    reproducciones75, 
    reproduccionesTotales, 
    curvaVisionado, 
    orden, 
    precioPorLead, 
    mostrar,
    clinica_id
  });
  
  res.status(201).json(campana);
});

// Actualizar una campaña
const updateCampana = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const campana = await Campana.findByPk(id);
  
  if (!campana) {
    res.status(404);
    throw new Error('Campaña no encontrada');
  }
  
  // Verificar si la clínica existe si se está actualizando
  if (req.body.clinica_id) {
    const clinica = await Clinica.findByPk(req.body.clinica_id);
    if (!clinica) {
      res.status(404);
      throw new Error('Clínica no encontrada');
    }
  }
  
  await campana.update(req.body);
  
  res.status(200).json(campana);
});

// Eliminar una campaña
const deleteCampana = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const campana = await Campana.findByPk(id);
  
  if (!campana) {
    res.status(404);
    throw new Error('Campaña no encontrada');
  }
  
  await campana.destroy();
  
  res.status(200).json({ message: 'Campaña eliminada correctamente' });
});

// Actualizar datos de campaña desde Facebook
const updateCampanaFromFacebook = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { facebookData } = req.body;
  
  const campana = await Campana.findByPk(id);
  
  if (!campana) {
    res.status(404);
    throw new Error('Campaña no encontrada');
  }
  
  // Actualizar datos de la campaña con la información de Facebook
  // Esta es una implementación básica, se puede expandir según necesidades
  await campana.update({
    gastoTotal: facebookData.gastoTotal || campana.gastoTotal,
    leads: facebookData.leads || campana.leads,
    frecuenciaMaxima: facebookData.frecuenciaMaxima || campana.frecuenciaMaxima,
    reproducciones75: facebookData.reproducciones75 || campana.reproducciones75,
    reproduccionesTotales: facebookData.reproduccionesTotales || campana.reproduccionesTotales,
    curvaVisionado: facebookData.curvaVisionado || campana.curvaVisionado,
    estado: facebookData.estado || campana.estado
  });
  
  res.status(200).json(campana);
});

// Obtener campañas por clínica
const getCampanasByClinica = asyncHandler(async (req, res) => {
  try {
    const { clinicaId } = req.params;
    const campanas = await Campana.findAll({
      where: { clinica_id: clinicaId },
      include: [{
        model: Clinica,
        as: 'clinica',
        attributes: ['id', 'nombre']
      }]
    });
    res.status(200).json(campanas);
  } catch (error) {
    console.error('Error al obtener campañas por clínica:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Sincronizar campañas de Facebook
const syncFacebookCampaigns = asyncHandler(async (req, res) => {
  try {
    // Implementación básica - puedes expandir según tus necesidades
    const { accessToken, adAccountId } = req.body;
    
    // Aquí iría la lógica de sincronización con Facebook
    // Por ahora, devolvemos un mensaje de éxito
    
    res.status(200).json({ 
      message: 'Sincronización iniciada correctamente',
      status: 'success'
    });
  } catch (error) {
    console.error('Error al sincronizar campañas de Facebook:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener estadísticas de campañas
const getCampanasStats = asyncHandler(async (req, res) => {
  try {
    const stats = await Campana.findAll({
      attributes: [
        [db.sequelize.fn('COUNT', db.sequelize.col('id_campana')), 'total_campanas'],
        [db.sequelize.fn('SUM', db.sequelize.col('gastoTotal')), 'gasto_total'],
        [db.sequelize.fn('AVG', db.sequelize.col('gastoTotal')), 'gasto_promedio'],
        [db.sequelize.fn('SUM', db.sequelize.col('leads')), 'leads_total']
      ]
    });
    
    res.status(200).json({
      estadisticas: stats[0],
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Error al obtener estadísticas de campañas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// EXPORTAR TODAS LAS FUNCIONES
module.exports = {
  getAllCampanas,
  getCampanaById,
  createCampana,
  updateCampana,
  deleteCampana,
  updateCampanaFromFacebook,
  getCampanasByClinica,
  syncFacebookCampaigns,
  getCampanasStats
};