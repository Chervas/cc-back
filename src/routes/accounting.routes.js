'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/accounting.controller');

const router = express.Router();
router.use(authMiddleware);
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
router.use(require('./accountingDocumentPreview.routes'));

router.use('/bank', (req,res,next)=>{
  if(req.method==='POST'&&!req.is('application/json'))return res.status(415).json({error:{code:'bank_json_required',message:'Envía la operación en formato JSON.'}});
  next();
});
router.get('/bank/workspace',controller.bankWorkspace);
router.get('/bank/lines',controller.bankLines);
router.get('/bank/targets',controller.bankTargets);
router.post('/bank/imports/preview',controller.bankPreviewImport);
router.post('/bank/imports',controller.bankCreateImport);
router.get('/bank/imports',controller.bankImports);
router.get('/bank/imports/:importId/source',controller.bankImportSource);
router.post('/bank/lines/:lineId/matches',controller.bankCreateMatches);
router.post('/bank/matches/:matchId/reverse',controller.bankReverseMatch);

router.get('/workspace', controller.getWorkspace);
router.get('/cash/workspace', controller.getCashWorkspace);
router.get('/firm', controller.getFirm);
router.post('/firm/credentials', controller.issueFirmCredentials);
router.post('/firm/revoke', controller.revokeFirmAccess);
router.get('/portal/scope', controller.getPortalScope);
router.get('/portal/workspace', controller.getPortalWorkspace);
router.get('/portal/export.csv', controller.exportPortalCsv);
router.get('/portal/export.zip', controller.exportPortalZip);
router.use('/ingestion', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({error: {code: 'accounting_ingestion_json_required', message: 'Envía el documento mediante la carga de Contabilidad en formato JSON.'}});
  next();
});
router.get('/ingestion', controller.listIngestion);
router.post('/ingestion', controller.enqueueIngestion);
router.post('/ingestion/:jobId/process', controller.processIngestion);
router.post('/ingestion/:jobId/accept', controller.acceptIngestion);
router.get('/ingestion/:jobId/source', controller.downloadIngestionSource);
router.get('/sepa', controller.getSepa);
router.post('/sepa/mandates', controller.createSepaMandate);
router.patch('/sepa/mandates/:mandateId', controller.updateSepaMandate);
router.post('/sepa/remittances', controller.createRemittance);
router.patch('/sepa/remittances/:remittanceId', controller.updateRemittanceStatus);
router.get('/sepa/remittances/:remittanceId.xml', controller.exportRemittance);
router.get('/documents/:documentId', controller.getFiscalDocument);
router.get('/documents/:documentId/source-budget', controller.getFiscalSourceBudget);
router.get('/export.csv', controller.exportCsv);
router.get('/export.zip', controller.exportZip);
router.post('/expenses', controller.createExpense);
router.get('/expenses/:expenseId',controller.getExpense);
router.patch('/expenses/:expenseId', controller.updateExpense);
router.get('/expenses/:expenseId/attachment', controller.downloadExpenseAttachment);
router.post('/cash/open', controller.openCash);
router.post('/cash/movements', controller.createCashMovement);
router.post('/cash/closures', controller.closeCash);
router.get('/payroll-employees', controller.listPayrollEmployees);
router.post('/payroll', controller.createPayroll);
router.get('/payroll/:payrollId',controller.getPayroll);
router.patch('/payroll/:payrollId', controller.updatePayroll);
router.get('/payroll/:payrollId/document', controller.downloadPayrollAttachment);
router.get('/payroll-documents/:documentId',controller.getPayrollDocument);
router.get('/payroll-documents/:documentId/document', controller.downloadPayrollDocumentAttachment);

router.use((error, req, res, next) => {
  if(req.path.startsWith('/bank')&&!error?.statusCode&&!error?.status)return res.status(500).json({error:{code:'bank_operation_uncertain',message:'No se pudo confirmar el resultado. Conserva la operación para reintentarlo.'}});
  if (!error?.statusCode && !error?.status) return next(error);
  res.status(error.statusCode || error.status).json({
    error: {
      code: error.code || error.message || 'accounting_error',
      message: error.message || 'No se pudo completar la operación.',
      details: error.details || null,
    },
  });
});

module.exports = router;
