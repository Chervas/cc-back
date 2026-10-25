'use strict';

const asyncHandler = require('express-async-handler');
const accounting = require('../services/accounting.service');
const firms = require('../services/accountingFirms.service');
const ingestion = require('../services/accountingIngestion.service');
const { renderDocumentPreview } = require('../services/accountingDocumentPreview.service');
const { canUserAccessFeature } = require('../lib/access-policy');

function context(req) {
  const clinicId = Number(req.query?.clinic_id), actorId = Number(req.userData?.userId);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) throw accounting.domainError(401, 'unauthenticated', 'Usuario no autenticado.');
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0 || !['string', 'number'].includes(typeof req.query?.clinic_id)) {
    throw accounting.domainError(400, 'clinic_scope_required', 'Debes indicar una clínica válida.');
  }
  return { clinicId, actorId };
}

// These are exactly the read permissions of the corresponding original endpoints.
async function authorize(ctx, features) {
  if (await firms.isPortalUser({ actorId: ctx.actorId })) {
    if (!features.includes('billing.reports.view')) throw accounting.domainError(403, 'accounting_portal_read_only', 'Este documento no está disponible en el portal de gestoría.');
    await firms.assertPortalClinic(ctx);
    return;
  }
  const allowed = await Promise.all(features.map(featureKey => canUserAccessFeature({ ...ctx, featureKey })));
  if (!allowed.some(Boolean)) throw accounting.domainError(403, 'access_policy_forbidden', 'No tienes permisos para este documento.');
}

function handler(kind) {
  return asyncHandler(async (req, res) => {
    const ctx = context(req);
    const features = kind === 'ingestion' ? ['accounting.ocr.manage']
      : kind === 'expense' ? ['billing.reports.view', 'accounting.expenses.manage', 'accounting.ocr.manage']
        : ['accounting.payroll.view'];
    await authorize(ctx, features);
    if (kind === 'ingestion' && await ingestion.kind({ publicId: req.params.jobId, clinicId: ctx.clinicId }) === 'payroll') {
      await authorize(ctx, ['accounting.payroll.view']);
    }
    const source = kind === 'ingestion' ? await ingestion.readSource({ publicId: req.params.jobId, clinicId: ctx.clinicId })
      : kind === 'expense' ? await accounting.readExpenseAttachment({ publicId: req.params.expenseId, clinicId: ctx.clinicId })
        : kind === 'payroll_document' ? await accounting.readPayrollDocumentAttachment({ publicId: req.params.documentId, clinicId: ctx.clinicId })
          : await accounting.readPayrollAttachment({ publicId: req.params.payrollId, clinicId: ctx.clinicId });
    const result = await renderDocumentPreview({ buffer: source.buffer, contentType: source.asset.content_type, page: req.query?.page, width: req.query?.width });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Document-Pages', String(result.pages));
    res.setHeader('X-Document-Page', String(result.page));
    res.send(result.buffer);
  });
}

module.exports = {
  ingestion: handler('ingestion'), expense: handler('expense'),
  payrollDocument: handler('payroll_document'), payroll: handler('payroll'),
};
