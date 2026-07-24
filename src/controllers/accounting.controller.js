'use strict';

const asyncHandler = require('express-async-handler');
const accounting = require('../services/accounting.service');
const { canUserAccessFeature } = require('../lib/access-policy');

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function actorId(req) {
  const id = positiveInteger(req.userData?.userId);
  if (!id) throw accounting.domainError(401, 'unauthenticated', 'Usuario no autenticado.');
  return id;
}

function clinicId(req) {
  const id = positiveInteger(req.body?.clinic_id ?? req.query?.clinic_id);
  if (!id) throw accounting.domainError(400, 'clinic_scope_required', 'Debes indicar una clínica válida.');
  return id;
}

async function requireFeature(req, featureKey) {
  const resolvedClinicId = clinicId(req);
  const allowed = await canUserAccessFeature({
    actorId: actorId(req),
    featureKey,
    clinicId: resolvedClinicId,
  });
  if (!allowed) throw accounting.domainError(403, 'access_policy_forbidden', 'No tienes permisos para esta operación.');
  return resolvedClinicId;
}

async function requireAnyFeature(req, featureKeys) {
  const resolvedClinicId = clinicId(req);
  const decisions = await Promise.all(featureKeys.map((featureKey) => canUserAccessFeature({
    actorId: actorId(req),
    featureKey,
    clinicId: resolvedClinicId,
  })));
  if (!decisions.some(Boolean)) throw accounting.domainError(403, 'access_policy_forbidden', 'No tienes permisos para este documento.');
  return resolvedClinicId;
}

exports.getWorkspace = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'billing.reports.view');
  res.json(await accounting.getWorkspace({ clinicId: resolvedClinicId, query: req.query }));
});

exports.createExpense = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.expenses.manage');
  res.status(201).json(await accounting.createExpense({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.updateExpense = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.expenses.manage');
  res.json(await accounting.updateExpense({
    publicId: req.params.expenseId,
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.downloadExpenseAttachment = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'billing.reports.view');
  const { asset, buffer } = await accounting.readExpenseAttachment({
    publicId: req.params.expenseId,
    clinicId: resolvedClinicId,
  });
  res.setHeader('Content-Type', asset.content_type);
  res.setHeader('Content-Disposition', `inline; filename="${String(asset.original_filename || 'factura').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

exports.createCashMovement = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.cash.manage');
  res.status(201).json(await accounting.createCashMovement({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.closeCash = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.cash.manage');
  res.status(201).json(await accounting.closeCash({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.getFiscalDocument = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireAnyFeature(req, ['billing.reports.view', 'patients.view']);
  res.json(await accounting.getFiscalDocument({
    publicId: req.params.documentId,
    clinicId: resolvedClinicId,
  }));
});

exports.exportCsv = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.export');
  const csv = await accounting.exportCsv({ clinicId: resolvedClinicId, query: req.query });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contabilidad-${resolvedClinicId}.csv"`);
  res.send(`\uFEFF${csv}`);
});
