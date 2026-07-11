'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/adminManagedCampaigns.controller');

const router = express.Router();
router.use(authMiddleware);

router.get('/access', controller.getAccess);
router.get('/dashboard', controller.getDashboard);
router.get('/matching/proposals', controller.listMatchingProposals);
router.post('/matching/confirm', controller.confirmMatching);
router.get('/inventory', controller.listExternalInventory);
router.post('/inventory', controller.upsertExternalInventory);
router.get('/bank-transactions', controller.listBankTransactions);
router.post('/bank-transactions', controller.createBankTransaction);
router.get('/reconciliation/proposals', controller.getReconciliationProposals);
router.post('/reconciliation/confirm', controller.confirmReconciliation);
router.get('/', controller.listCampaigns);
router.post('/', controller.createCampaign);
router.get('/:id', controller.getCampaign);
router.patch('/:id', controller.updateCampaign);
router.post('/:id/status', controller.transitionCampaign);
router.post('/:id/activate-management', controller.activateManagement);
router.post('/:id/topups', controller.recordTopup);
router.post('/:id/spend', controller.recordSpend);

module.exports = router;
