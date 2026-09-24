'use strict';

const { resolveClinicScope } = require('../lib/clinicScope');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { isGlobalAdmin } = require('../lib/role-helpers');
const service = require('../services/marketingEmail.service');

async function scope(req, access = 'read') {
  const raw = req.body?.scope || req.body?.clinic_id || req.query.scope || req.query.clinic_id || req.query.clinicId;
  const resolved = await resolveClinicScope(raw, { allowAll: false });
  if (!resolved.isValid) throw Object.assign(Error('Selecciona una clínica o grupo válido.'), { status: 400 });
  const allowed = await hasMarketingClinicScopeAccess({
    userId: req.userData?.userId,
    clinicIds: resolved.clinicIds,
    access,
  });
  if (!allowed) throw Object.assign(Error('No tienes permiso para configurar el email de este ámbito.'), { status: 403 });
  return resolved;
}

function handle(res, error, fallback) {
  const status = Number(error.status || 500);
  if (status >= 500) console.error('[marketing-email]', error.code || error.message || error);
  return res.status(status).json({ success: false, error: error.message || fallback, code: error.code || 'marketing_email_error', details: error.details || undefined });
}

function assertAdmin(req) {
  if (!isGlobalAdmin(req.userData?.userId)) {
    throw Object.assign(Error('Solo un administrador puede gestionar el catálogo de plantillas de email.'), {
      status: 403,
      code: 'email_template_catalog_forbidden',
    });
  }
}

exports.settings = async (req, res) => {
  try { return res.json({ success: true, ...(await service.listSettings(await scope(req))) }); }
  catch (error) { return handle(res, error, 'No se pudo cargar la configuración de email.'); }
};
exports.addDomain = async (req, res) => {
  try { return res.status(201).json({ success: true, domain: await service.addDomain(await scope(req, 'write'), req.body || {}, req.userData?.userId) }); }
  catch (error) { return handle(res, error, 'No se pudo añadir el dominio.'); }
};
exports.refreshDomain = async (req, res) => {
  try { return res.json({ success: true, domain: await service.refreshDomain(await scope(req, 'write'), req.params.id) }); }
  catch (error) { return handle(res, error, 'No se pudo comprobar el dominio.'); }
};
exports.addSender = async (req, res) => {
  try { return res.status(201).json({ success: true, sender: await service.addSender(await scope(req, 'write'), req.body || {}, req.userData?.userId) }); }
  catch (error) { return handle(res, error, 'No se pudo añadir el remitente.'); }
};
exports.setDefaultSender = async (req, res) => {
  try { return res.json({ success: true, sender: await service.setDefaultSender(await scope(req, 'write'), req.params.id) }); }
  catch (error) { return handle(res, error, 'No se pudo elegir el remitente.'); }
};
exports.listTemplates = async (req, res) => {
  try {
    const resolvedScope = await scope(req);
    const [templates, defaultDesign] = await Promise.all([
      service.listTemplates(resolvedScope),
      service.defaultDesignForScope(resolvedScope),
    ]);
    return res.json({ success: true, templates, default_design: defaultDesign });
  }
  catch (error) { return handle(res, error, 'No se pudieron cargar las plantillas.'); }
};
exports.getTemplate = async (req, res) => {
  try { return res.json({ success: true, template: await service.getTemplate(await scope(req), req.params.id) }); }
  catch (error) { return handle(res, error, 'No se pudo cargar la plantilla.'); }
};
exports.createTemplate = async (req, res) => {
  try { return res.status(201).json({ success: true, template: await service.saveTemplate(await scope(req, 'write'), req.body || {}, req.userData?.userId) }); }
  catch (error) { return handle(res, error, 'No se pudo crear la plantilla.'); }
};
exports.updateTemplate = async (req, res) => {
  try { return res.json({ success: true, template: await service.saveTemplate(await scope(req, 'write'), req.body || {}, req.userData?.userId, req.params.id) }); }
  catch (error) { return handle(res, error, 'No se pudo actualizar la plantilla.'); }
};
exports.duplicateTemplate = async (req, res) => {
  try {
    return res.status(201).json({
      success: true,
      template: await service.duplicateTemplate(await scope(req, 'write'), req.params.id, req.body || {}, req.userData?.userId),
    });
  }
  catch (error) { return handle(res, error, 'No se pudo duplicar la plantilla.'); }
};
exports.listCatalogTemplates = async (req, res) => {
  try { assertAdmin(req); return res.json({ success: true, templates: await service.listCatalogTemplates() }); }
  catch (error) { return handle(res, error, 'No se pudo cargar el catálogo de email.'); }
};
exports.createCatalogTemplate = async (req, res) => {
  try {
    assertAdmin(req);
    return res.status(201).json({ success: true, template: await service.saveCatalogTemplate(req.body || {}, req.userData?.userId) });
  }
  catch (error) { return handle(res, error, 'No se pudo crear la plantilla del catálogo.'); }
};
exports.updateCatalogTemplate = async (req, res) => {
  try {
    assertAdmin(req);
    return res.json({ success: true, template: await service.saveCatalogTemplate(req.body || {}, req.userData?.userId, req.params.id) });
  }
  catch (error) { return handle(res, error, 'No se pudo actualizar la plantilla del catálogo.'); }
};
exports.duplicateCatalogTemplate = async (req, res) => {
  try {
    assertAdmin(req);
    return res.status(201).json({ success: true, template: await service.duplicateCatalogTemplate(req.params.id, req.userData?.userId) });
  }
  catch (error) { return handle(res, error, 'No se pudo duplicar la plantilla del catálogo.'); }
};
exports.setCatalogTemplateActive = async (req, res) => {
  try {
    assertAdmin(req);
    return res.json({
      success: true,
      template: await service.setCatalogTemplateActive(req.params.id, req.body?.is_active, req.userData?.userId),
    });
  }
  catch (error) { return handle(res, error, 'No se pudo cambiar el estado de la plantilla del catálogo.'); }
};
exports.propagateCatalogTemplate = async (req, res) => {
  try {
    assertAdmin(req);
    return res.json({ success: true, ...(await service.propagateCatalogTemplate(req.params.id, req.userData?.userId)) });
  }
  catch (error) { return handle(res, error, 'No se pudo propagar la plantilla del catálogo.'); }
};
exports.costEstimate = async (req, res) => {
  try {
    await scope(req);
    return res.json({
      success: true,
      email: service.providerCostEstimate(req.query.recipients),
      whatsapp: service.whatsappProviderCostEstimate(req.query.recipients, req.query.whatsapp_category),
    });
  }
  catch (error) { return handle(res, error, 'No se pudo calcular el coste.'); }
};
exports.unsubscribe = async (req, res) => {
  try { return res.json(await service.unsubscribe(req.body?.token || req.query?.token)); }
  catch (error) { return handle(res, error, 'No se pudo registrar la baja.'); }
};
