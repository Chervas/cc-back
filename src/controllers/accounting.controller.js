'use strict';

const asyncHandler = require('express-async-handler');
const accounting = require('../services/accounting.service');
const accountingFirms = require('../services/accountingFirms.service');
const accountingIngestion = require('../services/accountingIngestion.service');
const accountingSepa = require('../services/accountingSepa.service');
const accountingExport = require('../services/accountingExport.service');
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
  const resolvedActorId = actorId(req);
  if (await accountingFirms.isPortalUser({ actorId: resolvedActorId })) {
    if (!['billing.reports.view', 'accounting.export'].includes(featureKey)) {
      throw accounting.domainError(403, 'accounting_portal_read_only', 'El portal de gestoría es de solo lectura.');
    }
    await accountingFirms.assertPortalClinic({
      actorId: resolvedActorId,
      clinicId: resolvedClinicId,
    });
    return resolvedClinicId;
  }
  const allowed = await canUserAccessFeature({
    actorId: resolvedActorId,
    featureKey,
    clinicId: resolvedClinicId,
  });
  if (!allowed) throw accounting.domainError(403, 'access_policy_forbidden', 'No tienes permisos para esta operación.');
  return resolvedClinicId;
}

async function requireAnyFeature(req, featureKeys) {
  const resolvedClinicId = clinicId(req);
  const resolvedActorId = actorId(req);
  if (await accountingFirms.isPortalUser({ actorId: resolvedActorId })) {
    if (!featureKeys.some((featureKey) => ['billing.reports.view', 'accounting.export'].includes(featureKey))) {
      throw accounting.domainError(403, 'accounting_portal_read_only', 'El portal de gestoría es de solo lectura.');
    }
    await accountingFirms.assertPortalClinic({
      actorId: resolvedActorId,
      clinicId: resolvedClinicId,
    });
    return resolvedClinicId;
  }
  const decisions = await Promise.all(featureKeys.map((featureKey) => canUserAccessFeature({
    actorId: resolvedActorId,
    featureKey,
    clinicId: resolvedClinicId,
  })));
  if (!decisions.some(Boolean)) throw accounting.domainError(403, 'access_policy_forbidden', 'No tienes permisos para este documento.');
  return resolvedClinicId;
}

exports.getWorkspace = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'billing.reports.view');
  const resolvedActorId = actorId(req);
  const portalMode = await accountingFirms.isPortalUser({ actorId: resolvedActorId });
  const includePayroll = !portalMode && await canUserAccessFeature({
    actorId: resolvedActorId,
    featureKey: 'accounting.payroll.view',
    clinicId: resolvedClinicId,
  });
  res.json(await accounting.getWorkspace({
    clinicId: resolvedClinicId,
    query: req.query,
    portalMode,
    includePayroll,
  }));
});

exports.getCashWorkspace = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.cash.manage');
  res.json(await accounting.getCashWorkspace({
    clinicId: resolvedClinicId,
    query: req.query,
  }));
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
  const resolvedClinicId = await requireAnyFeature(req, [
    'billing.reports.view',
    'accounting.expenses.manage',
    'accounting.ocr.manage',
  ]);
  const { asset, buffer } = await accounting.readExpenseAttachment({
    publicId: req.params.expenseId,
    clinicId: resolvedClinicId,
  });
  res.setHeader('Content-Type', asset.content_type);
  res.setHeader('Content-Disposition', `inline; filename="${String(asset.original_filename || 'factura').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

exports.openCash = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.cash.manage');
  res.status(201).json(await accounting.openCash({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
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

exports.createPayroll = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.payroll.manage');
  res.status(201).json(await accounting.createPayroll({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.updatePayroll = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.payroll.manage');
  res.json(await accounting.updatePayroll({
    publicId: req.params.payrollId,
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.downloadPayrollAttachment = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.payroll.view');
  const { asset, buffer } = await accounting.readPayrollAttachment({
    publicId: req.params.payrollId,
    clinicId: resolvedClinicId,
  });
  res.setHeader('Content-Type', asset.content_type);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${String(asset.original_filename || 'nominas').replace(/"/g, '')}"`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

exports.downloadPayrollDocumentAttachment = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.payroll.view');
  const { asset, buffer } = await accounting.readPayrollDocumentAttachment({
    publicId: req.params.documentId,
    clinicId: resolvedClinicId,
  });
  res.setHeader('Content-Type', asset.content_type);
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${String(asset.original_filename || 'nomina').replace(/"/g, '')}"`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
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

exports.getFirm = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.firm.manage');
  res.json(await accountingFirms.getFirm({ clinicId: resolvedClinicId }));
});

exports.issueFirmCredentials = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.firm.manage');
  res.json(await accountingFirms.issueCredentials({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
  }));
});

exports.getPortalScope = asyncHandler(async (req, res) => {
  res.json(await accountingFirms.portalScope({ actorId: actorId(req) }));
});

exports.getPortalWorkspace = asyncHandler(async (req, res) => {
  const { clinicId: resolvedClinicId } = await accountingFirms.assertPortalClinic({
    actorId: actorId(req),
    clinicId: req.query.clinic_id,
  });
  res.json(await accounting.getWorkspace({
    clinicId: resolvedClinicId,
    query: req.query,
    portalMode: true,
  }));
});

exports.exportPortalCsv = asyncHandler(async (req, res) => {
  const { clinicId: resolvedClinicId } = await accountingFirms.assertPortalClinic({
    actorId: actorId(req),
    clinicId: req.query.clinic_id,
  });
  const csv = await accounting.exportCsv({ clinicId: resolvedClinicId, query: req.query });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gestoria-${resolvedClinicId}.csv"`);
  res.send(`\uFEFF${csv}`);
});

exports.listIngestion = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.ocr.manage');
  if (String(req.query.document_kind || '').toLowerCase() === 'payroll') {
    await requireFeature(req, 'accounting.payroll.view');
  }
  res.json(await accountingIngestion.list({
    clinicId: resolvedClinicId,
    documentKind: req.query.document_kind,
  }));
});

exports.enqueueIngestion = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.ocr.manage');
  const documentKind = String(req.body.document_kind || 'expense').toLowerCase();
  if (documentKind === 'payroll') await requireFeature(req, 'accounting.payroll.manage');
  res.status(201).json(await accountingIngestion.enqueue({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    attachment: req.body.attachment,
    documentKind,
  }));
});

exports.processIngestion = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.ocr.manage');
  if (await accountingIngestion.kind({
    publicId: req.params.jobId,
    clinicId: resolvedClinicId,
  }) === 'payroll') {
    await requireFeature(req, 'accounting.payroll.manage');
  }
  res.json(await accountingIngestion.process({
    publicId: req.params.jobId,
    clinicId: resolvedClinicId,
  }));
});

exports.acceptIngestion = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.ocr.manage');
  if (await accountingIngestion.kind({
    publicId: req.params.jobId,
    clinicId: resolvedClinicId,
  }) === 'payroll') {
    await requireFeature(req, 'accounting.payroll.manage');
  }
  res.json(await accountingIngestion.accept({
    publicId: req.params.jobId,
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.downloadIngestionSource = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.ocr.manage');
  if (await accountingIngestion.kind({
    publicId: req.params.jobId,
    clinicId: resolvedClinicId,
  }) === 'payroll') {
    await requireFeature(req, 'accounting.payroll.view');
  }
  const { asset, buffer } = await accountingIngestion.readSource({
    publicId: req.params.jobId,
    clinicId: resolvedClinicId,
  });
  res.setHeader('Content-Type', asset.content_type);
  res.setHeader('Content-Disposition', `inline; filename="${String(asset.original_filename || 'factura').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

exports.getSepa = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.sepa.manage');
  res.json(await accountingSepa.list({ clinicId: resolvedClinicId }));
});

exports.createSepaMandate = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.sepa.manage');
  res.status(201).json(await accountingSepa.saveMandate({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.updateSepaMandate = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.sepa.manage');
  res.json(await accountingSepa.saveMandate({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
    publicId: req.params.mandateId,
  }));
});

exports.createRemittance = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.sepa.manage');
  res.status(201).json(await accountingSepa.createRemittance({
    clinicId: resolvedClinicId,
    actorId: actorId(req),
    payload: req.body,
  }));
});

exports.updateRemittanceStatus = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.sepa.manage');
  res.json(await accountingSepa.updateRemittanceStatus({
    clinicId: resolvedClinicId,
    publicId: req.params.remittanceId,
    status: req.body.status,
  }));
});

exports.exportRemittance = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.sepa.manage');
  const result = await accountingSepa.exportRemittance({
    clinicId: resolvedClinicId,
    publicId: req.params.remittanceId,
  });
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send(result.document);
});

exports.exportZip = asyncHandler(async (req, res) => {
  const resolvedClinicId = await requireFeature(req, 'accounting.export');
  const bundle = await accountingExport.exportBundle({
    clinicIds: [resolvedClinicId],
    query: req.query,
    actorId: actorId(req),
  });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="contabilidad-${resolvedClinicId}.zip"`);
  res.send(bundle);
});

exports.exportPortalZip = asyncHandler(async (req, res) => {
  const scope = await accountingFirms.portalScope({ actorId: actorId(req) });
  const requestedClinicId = positiveInteger(req.query.clinic_id);
  const clinicIds = requestedClinicId
    ? scope.clinics.filter((clinic) => clinic.id === requestedClinicId).map((clinic) => clinic.id)
    : scope.clinics.map((clinic) => clinic.id);
  if (!clinicIds.length) {
    throw accounting.domainError(403, 'accounting_portal_clinic_forbidden', 'La clínica no pertenece a esta gestoría.');
  }
  const bundle = await accountingExport.exportBundle({
    clinicIds,
    query: req.query,
    actorId: actorId(req),
  });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="gestoria-documentos.zip"');
  res.send(bundle);
});
