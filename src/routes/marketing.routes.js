const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const chatFlowTemplatesController = require('../controllers/chatFlowTemplates.controller');
const campaignOnboardingController = require('../controllers/campaignOnboarding.controller');
const marketingReportsController = require('../controllers/marketingReports.controller');
const marketingCompetitionController = require('../controllers/marketingCompetition.controller');
const marketingAiVisibilityController = require('../controllers/marketingAiVisibility.controller');
const marketingReactivationController = require('../controllers/marketingReactivation.controller');
const marketingBulkSendsController = require('../controllers/marketingBulkSends.controller');
const managedCampaignsController = require('../controllers/managedCampaigns.controller');
const campaignOptimizationController = require('../controllers/campaignOptimization.controller');

router.use(authMiddleware);

// Informes de marketing agregados (front no orquesta fuentes externas una a una)
router.get('/reports/overview', marketingReportsController.getOverview);
router.get('/reports/competition', marketingCompetitionController.getCompetition);
router.get('/reports/competition/suggestions', marketingCompetitionController.suggestCompetitors);
router.get('/reports/competition/local-heatmap', marketingCompetitionController.getLocalHeatmap);
router.post('/reports/competition/competitors', marketingCompetitionController.createCompetitor);
router.patch('/reports/competition/competitors/:competitorId', marketingCompetitionController.updateCompetitor);
router.delete('/reports/competition/competitors/:competitorId', marketingCompetitionController.deleteCompetitor);
router.post('/reports/competition/refresh', marketingCompetitionController.refreshCompetition);
router.get('/reports/competition/ai-visibility', marketingAiVisibilityController.getOverview);
router.post('/reports/competition/ai-visibility', marketingAiVisibilityController.createRun);
router.get('/reports/competition/ai-visibility/:runId', marketingAiVisibilityController.getRun);

// Reactivación de pacientes
router.get('/reactivation/suggestions', marketingReactivationController.getSuggestions);
router.get('/reactivation/lists', marketingReactivationController.listLists);
router.post('/reactivation/lists', marketingReactivationController.createList);
router.get('/reactivation/lists/:id', marketingReactivationController.getList);
router.patch('/reactivation/lists/:id', marketingReactivationController.updateList);
router.get('/reactivation/lists/:id/items', marketingReactivationController.getItems);
router.patch('/reactivation/lists/:id/items/:itemId', marketingReactivationController.updateItem);
router.get('/reactivation/lists/:id/events', marketingReactivationController.getEvents);
router.post('/reactivation/lists/:id/rebuild', marketingReactivationController.rebuildList);
router.post('/reactivation/lists/:id/prepare', marketingReactivationController.prepareList);
router.post('/reactivation/lists/:id/schedule', marketingReactivationController.scheduleList);
router.delete('/reactivation/lists/:id', marketingReactivationController.removeList);

// Envíos masivos por listas externas o pacientes actuales
router.get('/review-requests/summary', marketingBulkSendsController.getReviewRequestSummary);
router.get('/review-requests/automation-status', marketingBulkSendsController.getReviewRequestAutomationStatus);
router.patch('/review-requests/automation', marketingBulkSendsController.setReviewRequestAutomation);
router.get('/bulk-sends/campaigns', marketingBulkSendsController.listCampaigns);
router.post('/bulk-sends/campaigns', marketingBulkSendsController.createCampaign);
router.get('/bulk-sends/campaigns/:id', marketingBulkSendsController.getCampaign);
router.get('/bulk-sends/campaigns/:id/recipients', marketingBulkSendsController.listRecipients);
router.patch('/bulk-sends/campaigns/:id/recipients/:itemId', marketingBulkSendsController.updateRecipient);
router.get('/bulk-sends/campaigns/:id/dispatch', marketingBulkSendsController.getDispatchStatus);
router.patch('/bulk-sends/campaigns/:id', marketingBulkSendsController.updateCampaign);
router.post('/bulk-sends/campaigns/:id/prepare', marketingBulkSendsController.prepareCampaign);
router.post('/bulk-sends/campaigns/:id/send', marketingBulkSendsController.startDispatch);
router.post('/bulk-sends/campaigns/:id/cancel', marketingBulkSendsController.cancelDispatch);
router.post('/bulk-sends/campaigns/:id/resume', marketingBulkSendsController.resumeDispatch);
router.post('/bulk-sends/campaigns/:id/test-send', marketingBulkSendsController.sendTest);
router.delete('/bulk-sends/campaigns/:id', marketingBulkSendsController.removeCampaign);

// Catálogo de plantillas de flujos de chat (snippet web)
router.get('/chat-flow-templates', chatFlowTemplatesController.listChatFlowTemplates);
router.get('/chat-flow-templates/:id', chatFlowTemplatesController.getChatFlowTemplate);
router.post('/chat-flow-templates', chatFlowTemplatesController.createChatFlowTemplate);
router.put('/chat-flow-templates/:id', chatFlowTemplatesController.updateChatFlowTemplate);
router.delete('/chat-flow-templates/:id', chatFlowTemplatesController.deleteChatFlowTemplate);
router.post('/chat-flow-templates/:id/propagate', chatFlowTemplatesController.propagateChatFlowTemplate);
router.post('/chat-flow-templates/:id/duplicate', chatFlowTemplatesController.duplicateChatFlowTemplate);

// Onboarding unificado campañas (Google Ads + Meta Ads)
router.get('/campaign-onboarding/bootstrap', campaignOnboardingController.getCampaignOnboardingBootstrap);
router.get('/campaign-onboarding/meta-pixels', campaignOnboardingController.listMetaPixels);
router.get('/campaign-onboarding/external-campaigns', campaignOnboardingController.listExternalCampaigns);
router.get('/strategies/catalog', campaignOnboardingController.listStrategyCatalog);
router.get('/strategies/recommend-automation', campaignOnboardingController.getMarketingStrategyAutomationRecommendation);
router.post('/campaign-onboarding/start', campaignOnboardingController.startCampaignOnboarding);
router.get('/campaign-onboarding/:onboardingId/status', campaignOnboardingController.getCampaignOnboardingStatus);
router.get('/strategies', campaignOnboardingController.listMarketingStrategies);
router.post('/strategies', campaignOnboardingController.createMarketingStrategy);
router.patch('/strategies/:id', campaignOnboardingController.updateMarketingStrategy);
router.get('/strategies/:id', campaignOnboardingController.getMarketingStrategyDetail);
router.get('/strategies/:id/analysis/campaign', campaignOnboardingController.getMarketingStrategyAnalysisCampaign);
router.patch('/strategies/:id/status', campaignOnboardingController.transitionMarketingStrategyStatus);
router.get('/strategies/:id/metrics', campaignOnboardingController.getMarketingStrategyMetrics);

// Estado auditable del lifecycle de optimización. Es deliberadamente GET-only:
// evaluar una política no muta Google Ads ni aprueba transiciones.
router.get('/campaign-optimization/status', campaignOptimizationController.getOptimizationStatus);

// Piloto automático: la proyección cliente nunca expone comisión, coste neto ni cuentas internas.
router.get('/managed-campaigns', managedCampaignsController.listClientCampaigns);
router.post('/managed-campaigns/request', managedCampaignsController.requestAutopilot);
router.get('/managed-campaigns/:id', managedCampaignsController.getClientCampaign);
router.post('/managed-campaigns/:id/approve', managedCampaignsController.approveClientProposal);
router.post('/managed-campaigns/:id/request-changes', managedCampaignsController.requestClientProposalChanges);

// Google Ads onboarding helpers
router.get('/google-ads/conversion-actions', campaignOnboardingController.listGoogleAdsConversionActions);
router.post('/google-ads/conversion-actions/ensure', campaignOnboardingController.ensureGoogleAdsConversionActions);
router.post('/google-ads/conversions/data-manager/validate', campaignOnboardingController.validateGoogleDataManagerConversion);
router.post('/google-ads/conversions/enhanced/activation-gate', campaignOnboardingController.gateEnhancedConversionsActivation);

module.exports = router;
