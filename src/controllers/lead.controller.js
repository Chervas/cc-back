const db = require('../../models');
const Lead = db.Lead;
const Campana = db.Campana;
const Clinica = db.Clinica;
const asyncHandler = require('express-async-handler');
const notificationService = require('../services/notifications.service');

// Obtener todos los leads
exports.getAllLeads = asyncHandler(async (req, res) => {
  const leads = await Lead.findAll({
    include: [
      {
        model: Campana,
        as: 'campana',
        attributes: ['id', 'nombre', 'campaign_id']
      },
      {
        model: Clinica,
        as: 'clinica',
        attributes: ['id', 'nombre']
      }
    ]
  });
  
  res.status(200).json(leads);
});

// Obtener un lead por ID
exports.getLeadById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const lead = await Lead.findByPk(id, {
    include: [
      {
        model: Campana,
        as: 'campana',
        attributes: ['id', 'nombre', 'campaign_id']
      },
      {
        model: Clinica,
        as: 'clinica',
        attributes: ['id', 'nombre']
      }
    ]
  });
  
  if (!lead) {
    res.status(404);
    throw new Error('Lead no encontrado');
  }
  
  res.status(200).json(lead);
});

// Crear un nuevo lead
exports.createLead = asyncHandler(async (req, res) => {
  const { 
    nombre, 
    email, 
    telefono, 
    facebook_lead_id, 
    form_id, 
    fecha_creacion, 
    datos_adicionales, 
    estado, 
    notas,
    campana_id,
    clinica_id 
  } = req.body;
  
  // Verificar si la campaña existe
  if (campana_id) {
    const campana = await Campana.findByPk(campana_id);
    if (!campana) {
      res.status(404);
      throw new Error('Campaña no encontrada');
    }
  }
  
  // Verificar si la clínica existe
  let clinica = null;
  if (clinica_id) {
    clinica = await Clinica.findByPk(clinica_id);
    if (!clinica) {
      res.status(404);
      throw new Error('Clínica no encontrada');
    }
  }
  
  const lead = await Lead.create({
    nombre, 
    email, 
    telefono, 
    facebook_lead_id, 
    form_id, 
    fecha_creacion, 
    datos_adicionales, 
    estado, 
    notas,
    campana_id,
    clinica_id
  });
  
  // Si se crea un lead, actualizar el contador de leads en la campaña
  if (campana_id) {
    const campana = await Campana.findByPk(campana_id);
    await campana.update({
      leads: campana.leads + 1
    });
  }
  
  try {
    await notificationService.dispatchEvent({
      event: 'ads.new_lead',
      clinicId: clinica ? clinica.id_clinica : null,
      data: {
        clinicName: clinica?.nombre_clinica || null,
        leadName: nombre || email || telefono || 'Nuevo lead',
        leadId: lead.id,
        campaignId: campana_id || null,
        link: '/panel-principal?view=leads',
        useRouter: true
      }
    });
  } catch (notifyErr) {
    console.warn('⚠️ No se pudo emitir notificación de nuevo lead:', notifyErr.message || notifyErr);
  }

  res.status(201).json(lead);
});

// Actualizar un lead
exports.updateLead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const lead = await Lead.findByPk(id);
  
  if (!lead) {
    res.status(404);
    throw new Error('Lead no encontrado');
  }
  
  // Verificar si la campaña existe si se está actualizando
  if (req.body.campana_id) {
    const campana = await Campana.findByPk(req.body.campana_id);
    if (!campana) {
      res.status(404);
      throw new Error('Campaña no encontrada');
    }
  }
  
  // Verificar si la clínica existe si se está actualizando
  if (req.body.clinica_id) {
    const clinica = await Clinica.findByPk(req.body.clinica_id);
    if (!clinica) {
      res.status(404);
      throw new Error('Clínica no encontrada');
    }
  }
  
  await lead.update(req.body);
  
  res.status(200).json(lead);
});

// Eliminar un lead
exports.deleteLead = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const lead = await Lead.findByPk(id);
  
  if (!lead) {
    res.status(404);
    throw new Error('Lead no encontrado');
  }
  
  // Si se elimina un lead, actualizar el contador de leads en la campaña
  if (lead.campana_id) {
    const campana = await Campana.findByPk(lead.campana_id);
    if (campana && campana.leads > 0) {
      await campana.update({
        leads: campana.leads - 1
      });
    }
  }
  
  await lead.destroy();
  
  res.status(200).json({ message: 'Lead eliminado correctamente' });
});

// Recibir webhook de Facebook para leads
exports.receiveFacebookWebhook = asyncHandler(async (req, res) => {
  const { object, entry } = req.body;
  
  // Verificar que es un webhook de leads
  if (object !== 'page' || !entry || !Array.isArray(entry)) {
    return res.status(200).json({ success: true });
  }
  
  for (const pageEntry of entry) {
    if (pageEntry.changes && Array.isArray(pageEntry.changes)) {
      for (const change of pageEntry.changes) {
        if (change.field === 'leadgen' && change.value) {
          const leadData = change.value;
          
          // Buscar en AdCache para encontrar la campaña asociada
          const adCache = await db.AdCache.findOne({
            where: {
              ad_id: leadData.ad_id
            }
          });
          
          let campana_id = null;
          
          if (adCache) {
            // Buscar la campaña por campaign_id
            const campana = await Campana.findOne({
              where: {
                campaign_id: adCache.campaign_id
              }
            });
            
            if (campana) {
              campana_id = campana.id;
            }
          }
          
          // Crear el lead en la base de datos
          await Lead.create({
            facebook_lead_id: leadData.lead_id,
            form_id: leadData.form_id,
            fecha_creacion: new Date(),
            campana_id,
            estado: 'NUEVO'
          });
        }
      }
    }
  }
  
  res.status(200).json({ success: true });
});
