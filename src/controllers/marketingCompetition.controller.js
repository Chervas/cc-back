'use strict';

const { resolveClinicScope } = require('../lib/clinicScope');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { isGlobalAdmin } = require('../lib/role-helpers');
const competitionService = require('../services/marketingCompetition.service');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');

async function resolveScope(req, { allowAll = true } = {}) {
  const rawScope = req.query.clinicId
    || req.query.clinica_id
    || req.body?.clinicId
    || req.body?.clinica_id
    || req.body?.clinic_id
    || req.query.scope
    || req.body?.scope
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

async function assertScopeAccess(req, scope, access = 'read') {
  const userId = Number(req.userData?.userId || 0);
  if (scope.isAll) {
    if (isGlobalAdmin(userId)) return;
    const error = new Error('scope_forbidden');
    error.status = 403;
    throw error;
  }
  const allowed = await hasMarketingClinicScopeAccess({
    userId,
    clinicIds: scope.clinicIds || [],
    access,
  });
  if (!allowed) {
    const error = new Error(access === 'write' ? 'scope_write_forbidden' : 'scope_forbidden');
    error.status = 403;
    throw error;
  }
}

function sendError(res, error, fallbackMessage) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('❌ marketing competition error:', error);
  }
  return res.status(status).json({
    success: false,
    error: error.message || fallbackMessage,
  });
}

exports.getCompetition = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    await assertScopeAccess(req, scope, 'read');
    const includeInactive = req.query.includeInactive === 'true' || req.query.include_inactive === 'true';
    const result = await competitionService.listCompetition(scope, { includeInactive });
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
    return sendError(res, error, 'Error obteniendo informe de competencia');
  }
};

exports.suggestCompetitors = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'read');
    const result = await competitionService.suggestCompetitors(scope, {
      query: req.query.query || req.query.q || null,
      limit: req.query.limit,
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
    return sendError(res, error, 'Error sugiriendo competidores');
  }
};

exports.createCompetitor = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'write');
    const competitor = await competitionService.createCompetitor(scope, req.body || {});
    return res.status(201).json({ success: true, competitor });
  } catch (error) {
    return sendError(res, error, 'Error creando competidor');
  }
};

exports.updateCompetitor = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    await assertScopeAccess(req, scope, 'write');
    const competitor = await competitionService.updateCompetitor(scope, req.params.competitorId, req.body || {});
    return res.json({ success: true, competitor });
  } catch (error) {
    return sendError(res, error, 'Error actualizando competidor');
  }
};

exports.deleteCompetitor = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    await assertScopeAccess(req, scope, 'write');
    const result = await competitionService.deactivateCompetitor(scope, req.params.competitorId);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error desactivando competidor');
  }
};

exports.refreshCompetition = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    await assertScopeAccess(req, scope, 'write');
    const competitorIds = Array.isArray(req.body?.competitor_ids)
      ? req.body.competitor_ids
      : (Array.isArray(req.body?.competitorIds) ? req.body.competitorIds : null);
    const normalizedCompetitorIds = Array.from(new Set((competitorIds || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)))
      .sort((left, right) => left - right);
    const scopeClinicIds = Array.from(new Set((scope?.clinicIds || [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)))
      .sort((left, right) => left - right);
    const payload = {
      ...(scope?.scope === 'group' && scope.groupId ? { groupId: Number(scope.groupId) } : {}),
      ...(scope?.scope !== 'group' && scopeClinicIds.length === 1
        ? { clinicId: scopeClinicIds[0] }
        : {}),
      ...(scope?.scope !== 'group' && scopeClinicIds.length > 1
        ? { clinicIds: scopeClinicIds }
        : {}),
      ...(normalizedCompetitorIds.length ? { competitorIds: normalizedCompetitorIds } : {}),
    };
    const enqueueResult = await jobRequestsService.enqueueUniqueJobRequest({
      type: 'competition_refresh',
      payload,
      priority: 'low',
      origin: 'marketing_reports:competition_refresh',
      requestedBy: req.userData?.userId || null,
      requestedByRole: req.userData?.role || null,
      requestedByName: req.userData?.name || null,
      maxAttempts: 4,
    });
    const job = enqueueResult.job;
    jobScheduler.triggerImmediate(job.id).catch((error) => {
      console.error('❌ Error disparando competition_refresh desde cola:', error.message);
    });
    return res.status(202).json({
      success: true,
      queued: true,
      alreadyQueued: enqueueResult.created === false,
      jobRequestId: job.id,
      message: enqueueResult.created
        ? 'Actualización en cola. Puedes seguir trabajando; los datos se renovarán al terminar.'
        : 'Esta actualización ya estaba en cola y continuará en segundo plano.',
    });
  } catch (error) {
    return sendError(res, error, 'Error refrescando competencia');
  }
};

exports.getLocalHeatmap = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'read');
    const result = await competitionService.getLocalRankingHeatmap(scope, {
      term: req.query.term || null,
      zoomKm: req.query.zoom_km || req.query.zoomKm || null,
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
    return sendError(res, error, 'Error calculando mapa de ranking local');
  }
};
