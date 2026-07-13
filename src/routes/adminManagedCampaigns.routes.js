'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/adminManagedCampaigns.controller');

const router = express.Router();
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
router.use(authMiddleware);

router.get('/access', controller.getAccess);
router.use(controller.requireActiveOperator);
router.get('/operators', controller.getOperators);
router.get('/dashboard', controller.getDashboard);
router.get('/matching/options', controller.getMatchingOptions);
router.get('/matching/proposals', controller.listMatchingProposals);
router.post('/matching/confirm', controller.confirmMatching);
router.post('/matching/archive', controller.archiveMatching);
router.get('/matching/issues', controller.listMatchingIssues);
router.patch('/matching/assignments/:id/target', controller.updateMatchingTarget);
router.delete('/matching/assignments/:id/target', controller.clearMatchingTarget);
router.get('/matching/assignments/:id/audits', controller.listMatchingAssignmentAudits);
router.get('/inventory', controller.listExternalInventory);
router.post('/inventory', controller.upsertExternalInventory);
router.get('/bank-transactions', controller.listBankTransactions);
router.post('/bank-transactions', controller.createBankTransaction);
router.get('/reconciliation/proposals', controller.getReconciliationProposals);
router.post('/reconciliation/confirm', controller.confirmReconciliation);
router.get('/', controller.listCampaigns);
router.post('/', controller.createCampaign);
router.patch('/:id/coordination', controller.updateCoordination);
router.get('/:id/coordination-audits', controller.listCoordinationAudits);
router.get('/:id/publishing-plan', controller.getPublishingPlan);
router.post('/:id/publishing-dry-run', controller.createPublishingDryRun);
router.get('/:id/publishing-audits', controller.listPublishingAudits);
router.post('/:id/goal-policy/preview', controller.previewGoalPolicy);
router.post('/:id/goal-policy/apply', controller.applyGoalPolicy);
router.get('/:id', controller.getCampaign);
router.patch('/:id', controller.updateCampaign);
router.post('/:id/status', controller.transitionCampaign);
router.post('/:id/activate-management', controller.activateManagement);
router.post('/:id/topups', controller.recordTopup);
router.post('/:id/spend', controller.recordSpend);

module.exports = router;
