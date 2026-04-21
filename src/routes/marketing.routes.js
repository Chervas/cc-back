const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const chatFlowTemplatesController = require('../controllers/chatFlowTemplates.controller');
const campaignOnboardingController = require('../controllers/campaignOnboarding.controller');
const marketingReportsController = require('../controllers/marketingReports.controller');
const marketingCompetitionController = require('../controllers/marketingCompetition.controller');

router.use(authMiddleware);

// Informes de marketing agregados (front no orquesta fuentes externas una a una)
router.get('/reports/overview', marketingReportsController.getOverview);
router.get('/reports/competition', marketingCompetitionController.getCompetition);
router.get('/reports/competition/suggestions', marketingCompetitionController.suggestCompetitors);
router.post('/reports/competition/competitors', marketingCompetitionController.createCompetitor);
router.patch('/reports/competition/competitors/:competitorId', marketingCompetitionController.updateCompetitor);
router.delete('/reports/competition/competitors/:competitorId', marketingCompetitionController.deleteCompetitor);
router.post('/reports/competition/refresh', marketingCompetitionController.refreshCompetition);

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

// Google Ads onboarding helpers
router.get('/google-ads/conversion-actions', campaignOnboardingController.listGoogleAdsConversionActions);
router.post('/google-ads/conversion-actions/ensure', campaignOnboardingController.ensureGoogleAdsConversionActions);

module.exports = router;
