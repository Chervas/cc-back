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

function normalizeCompetitorIds(competitorIds = []) {
  return Array.from(new Set((Array.isArray(competitorIds) ? competitorIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)))
    .sort((left, right) => left - right);
}

function buildCompetitionRefreshPayload(scope, competitorIds = []) {
  const normalizedCompetitorIds = normalizeCompetitorIds(competitorIds);
  const scopeClinicIds = Array.from(new Set((scope?.clinicIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)))
    .sort((left, right) => left - right);

  return {
    ...(scope?.scope === 'group' && scope.groupId ? { groupId: Number(scope.groupId) } : {}),
    ...(scope?.scope !== 'group' && scopeClinicIds.length === 1
      ? { clinicId: scopeClinicIds[0] }
      : {}),
    ...(scope?.scope !== 'group' && scopeClinicIds.length > 1
      ? { clinicIds: scopeClinicIds }
      : {}),
    ...(normalizedCompetitorIds.length ? { competitorIds: normalizedCompetitorIds } : {}),
  };
}

async function enqueueCompetitionRefresh({
  scope,
  competitorIds = [],
  origin,
  requestedBy = null,
  requestedByRole = null,
  requestedByName = null,
  markCompetitorQueued = false,
}, dependencies = {}) {
  const jobs = dependencies.jobRequestsService || jobRequestsService;
  const scheduler = dependencies.jobScheduler || jobScheduler;
  const service = dependencies.competitionService || competitionService;
  const normalizedCompetitorIds = normalizeCompetitorIds(competitorIds);
  const payload = buildCompetitionRefreshPayload(scope, normalizedCompetitorIds);
  const singleCompetitorId = normalizedCompetitorIds.length === 1
    ? normalizedCompetitorIds[0]
    : null;
  const enqueueResult = await jobs.enqueueUniqueJobRequest({
    type: 'competition_refresh',
    payload,
    priority: 'low',
    origin,
    requestedBy,
    requestedByRole,
    requestedByName,
    maxAttempts: 4,
    // El alta puede ocurrir en una tanda. Un scope por competidor impide que
    // el primer JobRequest absorba silenciosamente los siguientes ids sin
    // incorporarlos a su payload. La lane background los procesa en serie.
    ...(singleCompetitorId ? { dedupeScope: `competition:competitor:${singleCompetitorId}` } : {}),
  });
  const job = enqueueResult.job;

  if (markCompetitorQueued && singleCompetitorId && enqueueResult.created !== false) {
    try {
      await service.updateCompetitor(scope, singleCompetitorId, {
        last_sync_status: 'queued',
        last_sync_error: null,
      });
    } catch (error) {
      // El JobRequest ya es durable. Un fallo secundario al reflejar el estado
      // no debe impedir que el worker hidrate el competidor.
      console.error('❌ No se pudo reflejar competition_refresh en el competidor:', error.message);
    }
  }

  scheduler.triggerImmediate(job.id).catch((error) => {
    // Aunque el wake-up inmediato falle, el JobRequest pendiente permanece
    // visible y la lane background lo reclamará en su siguiente tick.
    console.error('❌ Error disparando competition_refresh desde cola:', error.message);
  });

  return {
    job,
    created: enqueueResult.created !== false,
    payload,
  };
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
    let hydration;
    try {
      const enqueueResult = await enqueueCompetitionRefresh({
        scope,
        competitorIds: [competitor.id],
        origin: 'marketing_reports:competition_create',
        requestedBy: req.userData?.userId || null,
        requestedByRole: req.userData?.role || null,
        requestedByName: req.userData?.name || null,
        markCompetitorQueued: true,
      });
      competitor.last_sync_status = 'queued';
      competitor.last_sync_error = null;
      hydration = {
        status: 'queued',
        queued: true,
        alreadyQueued: enqueueResult.created === false,
        jobRequestId: enqueueResult.job.id,
      };
    } catch (queueError) {
      const queueMessage = queueError.message || 'No se pudo encolar la actualización';
      try {
        await competitionService.updateCompetitor(scope, competitor.id, {
          last_sync_status: 'queue_error',
          last_sync_error: queueMessage,
        });
      } catch (statusError) {
        console.error('❌ No se pudo guardar el error de hidratación del competidor:', statusError.message);
      }
      competitor.last_sync_status = 'queue_error';
      competitor.last_sync_error = queueMessage;
      hydration = {
        status: 'queue_error',
        queued: false,
        alreadyQueued: false,
        jobRequestId: null,
        error: queueMessage,
      };
    }
    return res.status(201).json({ success: true, competitor, hydration });
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
    const enqueueResult = await enqueueCompetitionRefresh({
      scope,
      competitorIds,
      origin: 'marketing_reports:competition_refresh',
      requestedBy: req.userData?.userId || null,
      requestedByRole: req.userData?.role || null,
      requestedByName: req.userData?.name || null,
    });
    const job = enqueueResult.job;
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

exports.__testing = {
  buildCompetitionRefreshPayload,
  enqueueCompetitionRefresh,
  normalizeCompetitorIds,
};

exports.getLocalHeatmap = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'read');
    const result = await competitionService.getLocalRankingHeatmap(scope, {
      term: req.query.term || null,
      zoomKm: req.query.zoom_km || req.query.zoomKm || null,
      cachedOnly: ['1', 'true', 'yes'].includes(String(req.query.cached_only || '').trim().toLowerCase()),
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

exports.listLocalHeatmapSearches = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'read');
    return res.json(await competitionService.listLocalHeatmapSearches(scope));
  } catch (error) {
    return sendError(res, error, 'Error cargando búsquedas locales');
  }
};

exports.saveLocalHeatmapSearch = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'write');
    const result = await competitionService.saveLocalHeatmapSearch(scope, {
      term: req.body?.term,
      zoomKm: req.body?.zoom_km || req.body?.zoomKm,
      userId: req.userData?.userId,
    });
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error, 'Error guardando búsqueda local');
  }
};

exports.deleteLocalHeatmapSearch = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    await assertScopeAccess(req, scope, 'write');
    return res.json(await competitionService.deleteLocalHeatmapSearch(scope, req.params.searchId));
  } catch (error) {
    return sendError(res, error, 'Error eliminando búsqueda local');
  }
};
