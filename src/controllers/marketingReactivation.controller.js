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

function sendError(res, error, fallbackMessage) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('❌ marketing reactivation error:', error);
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
