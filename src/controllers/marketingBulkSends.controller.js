'use strict';

const { resolveClinicScope } = require('../lib/clinicScope');
const marketingBulkSendsService = require('../services/marketingBulkSends.service');

async function resolveScope(req, { allowAll = false } = {}) {
  const rawScope = req.query.clinicId
    || req.query.clinica_id
    || req.query.clinic_id
    || req.query.scope
    || 'all';
  const scope = await resolveClinicScope(rawScope, { allowAll });
  if (scope.notFound) {
    const err = new Error('Grupo de clínicas no encontrado');
    err.status = 404;
    throw err;
  }
  if (!scope.isValid && !scope.isAll) {
    const err = new Error('clinicId/grupo inválido');
    err.status = 400;
    throw err;
  }
  return scope;
}

async function resolveScopeFromRequest(req, { allowAll = false } = {}) {
  const rawScope = req.body?.clinicId
    || req.body?.clinica_id
    || req.body?.clinic_id
    || req.body?.scope
    || req.query.clinicId
    || req.query.clinica_id
    || req.query.clinic_id
    || req.query.scope
    || 'all';
  const scope = await resolveClinicScope(rawScope, { allowAll });
  if (scope.notFound) {
    const err = new Error('Grupo de clínicas no encontrado');
    err.status = 404;
    throw err;
  }
  if (!scope.isValid && !scope.isAll) {
    const err = new Error('clinicId/grupo inválido');
    err.status = 400;
    throw err;
  }
  return scope;
}

function sendError(res, error, fallbackMessage) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('❌ marketing bulk sends error:', error);
  }
  const payload = {
    success: false,
    error: error.message || fallbackMessage,
  };
  if (error.details) {
    payload.details = error.details;
  }
  return res.status(status).json(payload);
}

exports.listCampaigns = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingBulkSendsService.listCampaigns(scope);
    return res.json({
      ...result,
      scope: {
        type: scope.scope,
        clinicIds: scope.clinicIds || [],
        groupId: scope.groupId || null,
        original: scope.original || null,
      },
    });
  } catch (error) {
    return sendError(res, error, 'Error listando campañas de envíos masivos');
  }
};

exports.createCampaign = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.createCampaign(scope, req.body || {}, req.userData?.userId || null);
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error, 'Error creando campaña de envíos masivos');
  }
};

exports.getCampaign = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingBulkSendsService.getCampaign(scope, req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error cargando campaña de envíos masivos');
  }
};

exports.prepareCampaign = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.prepareCampaign(scope, req.params.id, req.body || {}, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error preparando campaña de envíos masivos');
  }
};

exports.sendTest = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.sendTest(scope, req.params.id, req.body || {});
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error enviando prueba de WhatsApp');
  }
};

exports.removeCampaign = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.removeCampaign(scope, req.params.id, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error archivando campaña de envíos masivos');
  }
};
