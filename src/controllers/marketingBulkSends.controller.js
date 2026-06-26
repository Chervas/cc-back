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

exports.getReviewRequestSummary = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingBulkSendsService.getReviewRequestSummary(scope, {
      review_source: req.query.review_source || req.query.reviewSource || null,
      review_treatment_id: req.query.review_treatment_id || req.query.reviewTreatmentId || null,
      review_treatment_ids: req.query.review_treatment_ids || req.query.reviewTreatmentIds || null,
      review_treatment_moment: req.query.review_treatment_moment || req.query.reviewTreatmentMoment || null,
    });
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
    return sendError(res, error, 'Error cargando resumen de solicitudes de reseñas');
  }
};

exports.setReviewRequestAutomation = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.setReviewRequestAutomation(
      scope,
      req.body || {},
      req.userData?.userId || null
    );
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
    return sendError(res, error, 'Error actualizando automatización de reseñas');
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

exports.listRecipients = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingBulkSendsService.listRecipients(scope, req.params.id, req.query || {});
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error cargando destinatarios de envíos masivos');
  }
};

exports.updateRecipient = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.updateRecipient(
      scope,
      req.params.id,
      req.params.itemId,
      req.body || {},
      req.userData?.userId || null
    );
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error actualizando destinatario de envíos masivos');
  }
};

exports.updateCampaign = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.updateCampaign(scope, req.params.id, req.body || {}, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error actualizando campaña de envíos masivos');
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

exports.getDispatchStatus = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingBulkSendsService.getDispatchStatus(scope, req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error consultando progreso de envío');
  }
};

exports.startDispatch = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.startCampaignDispatch(scope, req.params.id, req.body || {}, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error iniciando envío masivo');
  }
};

exports.cancelDispatch = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.cancelCampaignDispatch(scope, req.params.id, req.body || {}, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error cancelando envío masivo');
  }
};

exports.resumeDispatch = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingBulkSendsService.resumeCampaignDispatch(scope, req.params.id, req.body || {}, req.userData || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error retomando envío masivo');
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
