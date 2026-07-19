'use strict';

const { isGlobalAdmin } = require('../lib/role-helpers');
const { withRequestContext } = require('./webProjects.controller');
const webIntakeRuntimeReconciliationService = require('../services/webIntakeRuntimeReconciliation.service');

const recoverFailedReconciliation = withRequestContext(async (req, res, requestId) => {
  const actorId = Number.parseInt(String(req.userData?.userId || ''), 10);
  if (!isGlobalAdmin(actorId)) {
    const error = new Error('Esta recuperación está reservada a administradores globales.');
    error.code = 'admin_only';
    error.status = 403;
    throw error;
  }
  // La recovery no usa el UUID generado por withRequestContext como sustituto
  // silencioso: el operador debe aportar una key que pueda reusar en un replay.
  const idempotencyKey = String(
    req.get('Idempotency-Key') || req.get('X-Request-Id') || ''
  ).trim();
  const result = await webIntakeRuntimeReconciliationService.recoverFailedReconciliation({
    reconciliationId: req.params.reconciliationId,
    action: req.body?.action,
    reason: req.body?.reason,
    confirmed: req.body?.confirmed === true,
    actorId,
    requestId: idempotencyKey,
  });
  return res.status(result.idempotent ? 200 : 202).json({
    success: true,
    recovery: result,
    request_id: requestId,
  });
}, 'No se ha podido iniciar la recuperación de la medición web.');

module.exports = { recoverFailedReconciliation };
