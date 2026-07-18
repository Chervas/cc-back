'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { clinicIdsFromStrategyRows, hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const service = require('../services/campaignDestinationBindings.service');

function userId(req) {
  const parsed = Number.parseInt(String(req?.userData?.userId || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function strategyRows(strategyId) {
  const id = positiveInteger(strategyId);
  return id ? db.CampaignRequest.findAll({ where: { campaign_id: id }, order: [['updated_at', 'DESC'], ['id', 'DESC']] }) : [];
}

async function requireScope(req, res, strategyId, access = 'read') {
  const rows = await strategyRows(strategyId);
  const clinicIds = clinicIdsFromStrategyRows(rows.map((row) => row?.get ? row.get({ plain: true }) : row));
  const allowed = clinicIds.length > 0 && await hasMarketingClinicScopeAccess({ userId: userId(req), clinicIds, access });
  if (!allowed) {
    res.status(403).json({ success: false, error: 'scope_forbidden', message: 'No tienes acceso a todas las clínicas de esta estrategia.' });
    return null;
  }
  return rows;
}

function sendError(res, error) {
  const status = Number(error?.httpStatus) || 500;
  return res.status(status).json({
    success: false,
    error: error?.code || 'campaign_destination_error',
    message: status >= 500 ? 'No se pudo completar la operación de destino.' : error.message,
    ...(status < 500 && error?.details ? { details: error.details } : {}),
  });
}

async function triggerJobs(result) {
  const ids = (Array.isArray(result?.jobs) ? result.jobs : [])
    .map((item) => positiveInteger(item?.job_request_id))
    .filter(Boolean);
  if (!ids.length) return;
  const scheduler = require('../services/jobScheduler.service');
  for (const id of ids) {
    scheduler.triggerImmediate(id).catch((error) => {
      console.error(`No se pudo despertar el job de destino ${id}; seguirá durable en cola:`, error.message);
    });
  }
}

exports.listForStrategy = asyncHandler(async (req, res) => {
  try {
    const strategyId = positiveInteger(req.params.id);
    if (!strategyId) return res.status(400).json({ success: false, error: 'strategy_id_invalid' });
    if (!(await requireScope(req, res, strategyId, 'read'))) return;
    const bindings = await db.CampaignDestinationBinding.findAll({ where: { strategyId }, order: [['created_at', 'ASC']] });
    const items = [];
    for (const binding of bindings) items.push(await service.getBinding(binding.id));
    return res.json({ success: true, items });
  } catch (error) {
    return sendError(res, error);
  }
});

exports.getBinding = asyncHandler(async (req, res) => {
  try {
    const binding = await service.getBinding(req.params.bindingId);
    if (!(await requireScope(req, res, binding.strategy_id, 'read'))) return;
    return res.json({ success: true, binding });
  } catch (error) {
    return sendError(res, error);
  }
});

exports.applyDestination = asyncHandler(async (req, res) => {
  try {
    const binding = await service.getBinding(req.params.bindingId);
    if (!(await requireScope(req, res, binding.strategy_id, 'write'))) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const confirmation = body.confirmation && typeof body.confirmation === 'object' ? body.confirmation : {};
    const operationId = confirmation.operation_id || req.get('Idempotency-Key');
    const result = await service.requestDestinationApply({
      bindingId: binding.id,
      accounts: body.accounts,
      confirmation: { ...confirmation, operation_id: operationId },
      actorUserId: userId(req),
    });
    await triggerJobs(result);
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});

exports.rollbackDestination = asyncHandler(async (req, res) => {
  try {
    const binding = await service.getBinding(req.params.bindingId);
    if (!(await requireScope(req, res, binding.strategy_id, 'write'))) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await service.requestDestinationRollback({
      bindingId: binding.id,
      accountIds: body.account_ids,
      reason: String(body.reason || 'manual').slice(0, 128),
      actorUserId: userId(req),
    });
    await triggerJobs(result);
    return res.status(202).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error);
  }
});
