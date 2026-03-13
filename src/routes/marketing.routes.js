const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const chatFlowTemplatesController = require('../controllers/chatFlowTemplates.controller');
const campaignOnboardingController = require('../controllers/campaignOnboarding.controller');

router.use(authMiddleware);

// Catálogo de plantillas de flujos de chat (snippet web)
router.get('/chat-flow-templates', chatFlowTemplatesController.listChatFlowTemplates);
router.get('/chat-flow-templates/:id', chatFlowTemplatesController.getChatFlowTemplate);
router.post('/chat-flow-templates', chatFlowTemplatesController.createChatFlowTemplate);
router.put('/chat-flow-templates/:id', chatFlowTemplatesController.updateChatFlowTemplate);
router.delete('/chat-flow-templates/:id', chatFlowTemplatesController.deleteChatFlowTemplate);
router.post('/chat-flow-templates/:id/duplicate', chatFlowTemplatesController.duplicateChatFlowTemplate);

// Onboarding unificado campañas (Google Ads + Meta Ads)
router.get('/campaign-onboarding/bootstrap', campaignOnboardingController.getCampaignOnboardingBootstrap);
router.post('/campaign-onboarding/start', campaignOnboardingController.startCampaignOnboarding);
router.get('/campaign-onboarding/:onboardingId/status', campaignOnboardingController.getCampaignOnboardingStatus);

// Google Ads onboarding helpers
router.get('/google-ads/conversion-actions', campaignOnboardingController.listGoogleAdsConversionActions);
router.post('/google-ads/conversion-actions/ensure', campaignOnboardingController.ensureGoogleAdsConversionActions);

module.exports = router;
