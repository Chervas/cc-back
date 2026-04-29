'use strict';

const { resolveClinicScope } = require('../lib/clinicScope');
const marketingReactivationService = require('../services/marketingReactivation.service');

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
    console.error('❌ marketing reactivation error:', error);
  }
  if (error?.payload && typeof error.payload === 'object') {
    return res.status(status).json(error.payload);
  }
  return res.status(status).json({
    success: false,
    error: error.message || fallbackMessage,
  });
}

exports.getSuggestions = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingReactivationService.getSuggestions(scope, {
      limit: req.query.limit,
      limit_rows: req.query.limit_rows,
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
    return sendError(res, error, 'Error calculando sugerencias de reactivación');
  }
};

exports.listLists = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingReactivationService.getLists(scope);
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
    return sendError(res, error, 'Error listando listas de reactivación');
  }
};

exports.createList = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingReactivationService.createList(scope, req.body || {}, req.userData?.userId || null);
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error, 'Error creando lista de reactivación');
  }
};

exports.getList = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingReactivationService.getList(scope, req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error cargando lista de reactivación');
  }
};

exports.getItems = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingReactivationService.getItems(scope, req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error cargando pacientes de la lista');
  }
};

exports.prepareList = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingReactivationService.prepareList(scope, req.params.id, req.body || {}, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error preparando lista de reactivación');
  }
};

exports.rebuildList = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingReactivationService.rebuildList(scope, req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error recalculando lista de reactivación');
  }
};

exports.scheduleList = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingReactivationService.scheduleList(scope, req.params.id, req.body || {});
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error programando lista de reactivación');
  }
};

exports.removeList = async (req, res) => {
  try {
    const scope = await resolveScopeFromRequest(req, { allowAll: false });
    const result = await marketingReactivationService.removeList(scope, req.params.id, req.userData?.userId || null);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error eliminando o archivando lista de reactivación');
  }
};

exports.getEvents = async (req, res) => {
  try {
    const scope = await resolveScope(req, { allowAll: false });
    const result = await marketingReactivationService.getEvents(scope, req.params.id);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, 'Error cargando auditoría de reactivación');
  }
};
