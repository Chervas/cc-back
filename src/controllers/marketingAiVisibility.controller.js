'use strict';

const { resolveClinicScope } = require('../lib/clinicScope');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { isGlobalAdmin } = require('../lib/role-helpers');
const aiVisibilityService = require('../services/marketingAiVisibility.service');

function rawClinicId(req) {
  return req.query?.clinicId
    || req.query?.clinica_id
    || req.body?.clinicId
    || req.body?.clinica_id
    || req.body?.clinic_id
    || null;
}

async function resolveSingleClinicScope(req) {
  const raw = rawClinicId(req);
  if (!raw || String(raw).toLowerCase() === 'all' || String(raw).startsWith('group:')) {
    const error = new Error('Selecciona una clínica concreta para comprobar su visibilidad en IA.');
    error.code = 'AI_VISIBILITY_SINGLE_CLINIC_REQUIRED';
    error.status = 400;
    throw error;
  }
  const scope = await resolveClinicScope(raw, { allowAll: false });
  if (scope.notFound) {
    const error = new Error('Clínica no encontrada.');
    error.status = 404;
    throw error;
  }
  const clinicIds = Array.from(new Set((scope.clinicIds || []).map(Number).filter(Number.isInteger)));
  if (!scope.isValid || clinicIds.length !== 1) {
    const error = new Error('Selecciona una clínica concreta para comprobar su visibilidad en IA.');
    error.code = 'AI_VISIBILITY_SINGLE_CLINIC_REQUIRED';
    error.status = 400;
    throw error;
  }
  return { scope, clinicId: clinicIds[0] };
}

async function assertAccess(req, clinicId, access = 'read') {
  const userId = Number(req.userData?.userId || 0);
  if (isGlobalAdmin(userId)) return;
  const allowed = await hasMarketingClinicScopeAccess({ userId, clinicIds: [clinicId], access });
  if (!allowed) {
    const error = new Error(access === 'write' ? 'scope_write_forbidden' : 'scope_forbidden');
    error.status = 403;
    throw error;
  }
}

function sendError(res, error, fallback) {
  const status = error.status || 500;
  if (status >= 500) console.error('❌ marketing AI visibility error:', error);
  return res.status(status).json({
    success: false,
    error: error.code || error.message || fallback,
    message: error.message || fallback,
  });
}

exports.getOverview = async (req, res) => {
  try {
    const { clinicId } = await resolveSingleClinicScope(req);
    await assertAccess(req, clinicId, 'read');
    const result = await aiVisibilityService.getOverview(clinicId, { limit: req.query?.limit });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error obteniendo visibilidad en asistentes de IA');
  }
};

exports.createRun = async (req, res) => {
  try {
    const { clinicId } = await resolveSingleClinicScope(req);
    await assertAccess(req, clinicId, 'write');
    const result = await aiVisibilityService.enqueueRun({
      clinicId,
      query: req.body?.query,
      requestedBy: req.userData?.userId || null,
      requestedByName: req.userData?.name || null,
      requestedByRole: req.userData?.role || null,
    });
    return res.status(result.reused ? 200 : 202).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Error iniciando la comprobación de visibilidad');
  }
};

exports.getRun = async (req, res) => {
  try {
    const { clinicId } = await resolveSingleClinicScope(req);
    await assertAccess(req, clinicId, 'read');
    const runId = Number(req.params.runId || 0);
    if (!Number.isInteger(runId) || runId <= 0) {
      const error = new Error('Identificador de comprobación inválido.');
      error.status = 400;
      throw error;
    }
    const run = await aiVisibilityService.getRun(runId, clinicId);
    return res.json({ success: true, run });
  } catch (error) {
    return sendError(res, error, 'Error obteniendo la comprobación de visibilidad');
  }
};

exports.__testing = {
  rawClinicId,
  resolveSingleClinicScope,
};
