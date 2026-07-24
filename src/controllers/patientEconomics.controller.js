'use strict';

const db = require('../../models');
const economics = require('../services/patientEconomics.service');
const { getAccessibleClinicIdsForFeature } = require('../lib/access-policy');

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function actorId(req) {
  const id = positiveInteger(req.userData?.userId);
  if (!id) throw economics.domainError(401, 'unauthenticated', 'Usuario no autenticado.');
  return id;
}

async function requireClinicFeature(req, featureKey, clinicId) {
  const resolvedClinicId = positiveInteger(clinicId);
  if (!resolvedClinicId) {
    throw economics.domainError(400, 'clinic_scope_required', 'Debes indicar una clínica válida.');
  }
  const allowed = await getAccessibleClinicIdsForFeature({
    actorId: actorId(req),
    featureKey,
    clinicIds: [resolvedClinicId],
  });
  if (!allowed.includes(resolvedClinicId)) {
    throw economics.domainError(403, 'access_policy_forbidden', 'No tienes permisos para esta clínica.');
  }
  return resolvedClinicId;
}

async function requireBudgetFeature(req, featureKey) {
  const budget = await db.EconomicBudget.findOne({
    where: { public_id: String(req.params.budgetId || '').trim() },
    attributes: ['clinic_id'],
  });
  if (!budget) throw economics.domainError(404, 'budget_not_found', 'Presupuesto no encontrado.');
  return requireClinicFeature(req, featureKey, budget.clinic_id);
}

async function requireVoucherFeature(req, featureKey) {
  const voucher = await db.PatientVoucher.findOne({
    where: { public_id: String(req.params.voucherId || '').trim() },
    attributes: ['clinic_id'],
  });
  if (!voucher) throw economics.domainError(404, 'voucher_not_found', 'Bono no encontrado.');
  return requireClinicFeature(req, featureKey, voucher.clinic_id);
}

async function requirePaymentFeature(req, featureKey) {
  const payment = await db.EconomicPayment.findOne({
    where: { public_id: String(req.params.paymentId || '').trim() },
    attributes: ['clinic_id'],
  });
  if (!payment) throw economics.domainError(404, 'payment_not_found', 'Cobro no encontrado.');
  return requireClinicFeature(req, featureKey, payment.clinic_id);
}

async function requireFiscalDocumentFeature(req, featureKey) {
  const document = await db.PatientFiscalDocument.findOne({
    where: { public_id: String(req.params.documentId || '').trim() },
    attributes: ['clinic_id'],
  });
  if (!document) throw economics.domainError(404, 'fiscal_document_not_found', 'Documento fiscal no encontrado.');
  return requireClinicFeature(req, featureKey, document.clinic_id);
}

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

exports.getWorkspace = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'patients.view',
    req.query.clinic_id ?? req.query.clinica_id
  );
  const workspace = await economics.getWorkspace({
    patientIdentifier: req.params.patientId,
    clinicId,
  });
  res.json(workspace);
});

exports.listCatalog = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'patients.view',
    req.query.clinic_id ?? req.query.clinica_id
  );
  const catalog = await economics.listCatalog({
    clinicId,
    patientIdentifier: req.query.patient_id,
    query: req.query,
  });
  res.json(catalog);
});

exports.createBudget = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'patients.edit',
    req.body.clinic_id ?? req.body.clinica_id
  );
  const budget = await economics.createBudget({
    patientIdentifier: req.params.patientId,
    clinicId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(budget);
});

exports.updateBudget = asyncHandler(async (req, res) => {
  await requireBudgetFeature(req, 'patients.edit');
  const budget = await economics.updateDraftBudget({
    publicId: req.params.budgetId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.json(budget);
});

exports.reviseBudget = asyncHandler(async (req, res) => {
  await requireBudgetFeature(req, 'patients.edit');
  const budget = await economics.reviseBudget({
    publicId: req.params.budgetId,
    actorId: actorId(req),
  });
  res.status(201).json(budget);
});

exports.transitionBudget = asyncHandler(async (req, res) => {
  await requireBudgetFeature(req, 'patients.edit');
  const budget = await economics.transitionBudget({
    publicId: req.params.budgetId,
    actorId: actorId(req),
    action: String(req.body.action || '').trim(),
    payload: req.body,
  });
  res.json(budget);
});

exports.createPayment = asyncHandler(async (req, res) => {
  await requireBudgetFeature(req, 'patients.edit');
  const payment = await economics.createPayment({
    publicId: req.params.budgetId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(payment);
});

exports.createWalletDeposit = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'patients.edit',
    req.body.clinic_id ?? req.body.clinica_id
  );
  const result = await economics.createWalletDeposit({
    patientIdentifier: req.params.patientId,
    clinicId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(result);
});

exports.voidPayment = asyncHandler(async (req, res) => {
  await requirePaymentFeature(req, 'patients.edit');
  const payment = await economics.voidPayment({
    publicId: req.params.paymentId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.json(payment);
});

exports.applyWallet = asyncHandler(async (req, res) => {
  await requireBudgetFeature(req, 'patients.edit');
  const result = await economics.applyWallet({
    publicId: req.params.budgetId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(result);
});

exports.consumeVoucher = asyncHandler(async (req, res) => {
  await requireVoucherFeature(req, 'patients.edit');
  const result = await economics.consumeVoucher({
    publicId: req.params.voucherId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(result);
});

exports.createVoucher = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'patients.edit',
    req.body.clinic_id ?? req.body.clinica_id
  );
  const voucher = await economics.createVoucher({
    patientIdentifier: req.params.patientId,
    clinicId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(voucher);
});

exports.createFiscalDocument = asyncHandler(async (req, res) => {
  await requireBudgetFeature(req, 'patients.edit');
  const document = await economics.createFiscalDocument({
    publicId: req.params.budgetId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(document);
});

exports.updateFiscalDocument = asyncHandler(async (req, res) => {
  await requireFiscalDocumentFeature(req, 'patients.edit');
  const document = await economics.updateFiscalDocument({
    publicId: req.params.documentId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.json(document);
});

exports.listTemplates = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'patients.view',
    req.query.clinic_id ?? req.query.clinica_id
  );
  const templates = await economics.listTemplates({
    clinicId,
    templateType: req.query.template_type || null,
    areaCode: req.query.area_code || null,
  });
  res.json({ items: templates });
});

exports.createTemplate = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'clinic.settings.edit',
    req.body.clinic_id ?? req.body.clinica_id
  );
  const template = await economics.saveTemplate({
    clinicId,
    actorId: actorId(req),
    payload: req.body,
  });
  res.status(201).json(template);
});

exports.updateTemplate = asyncHandler(async (req, res) => {
  const clinicId = await requireClinicFeature(
    req,
    'clinic.settings.edit',
    req.body.clinic_id ?? req.body.clinica_id
  );
  const template = await economics.saveTemplate({
    clinicId,
    actorId: actorId(req),
    payload: req.body,
    publicId: req.params.templateId,
  });
  res.json(template);
});
