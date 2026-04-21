'use strict';

const { resolveClinicScope } = require('../lib/clinicScope');
const competitionService = require('../services/marketingCompetition.service');

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
    const competitor = await competitionService.createCompetitor(scope, req.body || {});
    return res.status(201).json({ success: true, competitor });
  } catch (error) {
    return sendError(res, error, 'Error creando competidor');
  }
};

exports.updateCompetitor = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    const competitor = await competitionService.updateCompetitor(scope, req.params.competitorId, req.body || {});
    return res.json({ success: true, competitor });
  } catch (error) {
    return sendError(res, error, 'Error actualizando competidor');
  }
};

exports.deleteCompetitor = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    const result = await competitionService.deactivateCompetitor(scope, req.params.competitorId);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error desactivando competidor');
  }
};

exports.refreshCompetition = async (req, res) => {
  try {
    const scope = await resolveScope(req);
    const competitorIds = Array.isArray(req.body?.competitor_ids)
      ? req.body.competitor_ids
      : (Array.isArray(req.body?.competitorIds) ? req.body.competitorIds : null);
    const result = await competitionService.refreshCompetition(scope, { competitorIds });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error refrescando competencia');
  }
};
