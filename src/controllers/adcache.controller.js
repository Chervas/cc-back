const db = require('../../models');
const AdCache = db.AdCache;
const asyncHandler = require('express-async-handler');

// Obtener todos los registros de AdCache
exports.getAllAdCache = asyncHandler(async (req, res) => {
  const adCaches = await AdCache.findAll();
  
  res.status(200).json(adCaches);
});

// Crear o actualizar un registro de AdCache
exports.createOrUpdateAdCache = asyncHandler(async (req, res) => {
  const { ad_id, adset_id, campaign_id } = req.body;
  
  // Buscar si ya existe un registro con el mismo ad_id
  let adCache = await AdCache.findOne({
    where: { ad_id }
  });
  
  if (adCache) {
    // Actualizar el registro existente
    await adCache.update({
      adset_id,
      campaign_id,
      ultima_actualizacion: new Date()
    });
  } else {
    // Crear un nuevo registro
    adCache = await AdCache.create({
      ad_id,
      adset_id,
      campaign_id,
      ultima_actualizacion: new Date()
    });
  }
  
  res.status(200).json(adCache);
});

// Actualizar múltiples registros de AdCache (para batch updates)
exports.batchUpdateAdCache = asyncHandler(async (req, res) => {
  const { items } = req.body;
  
  if (!items || !Array.isArray(items)) {
    res.status(400);
    throw new Error('Se requiere un array de items para actualización por lotes');
  }
  
  const results = [];
  
  // Procesar cada item en el batch
  for (const item of items) {
    const { ad_id, adset_id, campaign_id } = item;
    
    if (!ad_id || !adset_id || !campaign_id) {
      continue; // Saltar items incompletos
    }
    
    // Buscar o crear el registro
    let [adCache, created] = await AdCache.findOrCreate({
      where: { ad_id },
      defaults: {
        adset_id,
        campaign_id,
        ultima_actualizacion: new Date()
      }
    });
    
    // Si el registro ya existía, actualizarlo
    if (!created) {
      await adCache.update({
        adset_id,
        campaign_id,
        ultima_actualizacion: new Date()
      });
    }
    
    results.push(adCache);
  }
  
  res.status(200).json({
    success: true,
    count: results.length,
    results
  });
});
