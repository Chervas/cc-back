'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/accounting.controller');

const router = express.Router();
router.use(authMiddleware);

router.get('/workspace', controller.getWorkspace);
router.get('/documents/:documentId', controller.getFiscalDocument);
router.get('/export.csv', controller.exportCsv);
router.post('/expenses', controller.createExpense);
router.patch('/expenses/:expenseId', controller.updateExpense);
router.get('/expenses/:expenseId/attachment', controller.downloadExpenseAttachment);
router.post('/cash/movements', controller.createCashMovement);
router.post('/cash/closures', controller.closeCash);

router.use((error, req, res, next) => {
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
