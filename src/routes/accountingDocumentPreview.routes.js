'use strict';

// Mounted by accounting.routes after authentication and private-response headers.
const router = require('express').Router();
const controller = require('../controllers/accountingDocumentPreview.controller');
router.get('/ingestion/:jobId/preview', controller.ingestion);
router.get('/expenses/:expenseId/preview', controller.expense);
router.get('/payroll-documents/:documentId/preview', controller.payrollDocument);
router.get('/payroll/:payrollId/preview', controller.payroll);
module.exports = router;
