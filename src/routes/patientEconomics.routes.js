'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/patientEconomics.controller');

const router = express.Router();
router.use(authMiddleware);

router.get('/patients/:patientId/workspace', controller.getWorkspace);
router.get('/catalog', controller.listCatalog);
router.post('/patients/:patientId/budgets', controller.createBudget);
router.patch('/budgets/:budgetId', controller.updateBudget);
router.post('/budgets/:budgetId/revise', controller.reviseBudget);
router.post('/budgets/:budgetId/transition', controller.transitionBudget);
router.post('/budgets/:budgetId/payments', controller.createPayment);
router.post('/patients/:patientId/wallet-deposits', controller.createWalletDeposit);
router.post('/patients/:patientId/fiscal-documents', controller.createPatientFiscalDocument);
router.post('/payments/:paymentId/void', controller.voidPayment);
router.post('/budgets/:budgetId/wallet-allocations', controller.applyWallet);
router.post('/budgets/:budgetId/fiscal-documents', controller.createFiscalDocument);
router.get('/budgets/:budgetId/pdf', controller.downloadBudgetPdf);
router.patch('/fiscal-documents/:documentId', controller.updateFiscalDocument);
router.get('/fiscal-documents/:documentId/pdf', controller.downloadFiscalDocumentPdf);
router.post('/patients/:patientId/vouchers', controller.createVoucher);
router.post('/vouchers/:voucherId/consume', controller.consumeVoucher);
router.get('/vouchers/:voucherId/appointment-resources', controller.getVoucherAppointmentResources);
router.post('/vouchers/:voucherId/appointment-plan', controller.previewVoucherAppointments);
router.post('/vouchers/:voucherId/appointments', controller.createVoucherAppointments);
router.get('/templates', controller.listTemplates);
router.post('/templates', controller.createTemplate);
router.patch('/templates/:templateId', controller.updateTemplate);

router.use((error, req, res, next) => {
  if (!error?.statusCode) return next(error);
  return res.status(error.statusCode).json({
    error: {
      code: error.code || 'economics_error',
      message: error.message,
      details: error.details || null,
    },
  });
});

module.exports = router;
