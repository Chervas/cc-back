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
const marketingObjectivesController = require('../controllers/marketingObjectives.controller');
const webProjectsController = require('../controllers/webProjects.controller');
const webContentMediaController = require('../controllers/webContentMedia.controller');
const webContentGenerationController = require('../controllers/webContentGeneration.controller');
const webArtifactsController = require('../controllers/webArtifacts.controller');
const webPublicationsController = require('../controllers/webPublications.controller');
const webDomainsController = require('../controllers/webDomains.controller');
const webWordpressInstallationsController = require('../controllers/webWordpressInstallations.controller');
const { WORDPRESS_V2_ARTIFACT_RATE_LIMIT } = require('../services/webWordpressInstallations.service');
const campaignDestinationBindingsController = require('../controllers/campaignDestinationBindings.controller');
const {
  createMarketingWebRateLimiter,
  createPublicMarketingWebRateLimiter,
} = require('../lib/marketingWebRequestGuards');

// Control plane del plugin: autenticación por token de instalación. Debe
// declararse antes del middleware de sesión porque WordPress no usa JWT de UI.
const publicWebRateLimit = createPublicMarketingWebRateLimiter();
router.get(
  '/web-installations/:installationId/desired-state',
  publicWebRateLimit({
    operation: 'web_installation_state',
    limit: 120,
    globalIpLimit: 2400,
    windowMs: 60 * 60 * 1000,
  }),
  webWordpressInstallationsController.getDesiredState
);
router.post(
  '/web-installations/:installationId/reports',
  publicWebRateLimit({
    operation: 'web_installation_report',
    limit: 120,
    globalIpLimit: 1200,
    windowMs: 60 * 60 * 1000,
  }),
  webWordpressInstallationsController.reportInstallation
);
const publicWebArtifactRateLimit = publicWebRateLimit({
  // A v2 registry is rejected above 500 authenticated artifact requests per
  // full sync. The extra 20% permits a bounded retry without making this a
  // general-purpose download endpoint.
  operation: 'web_installation_artifact',
  limit: WORDPRESS_V2_ARTIFACT_RATE_LIMIT,
  globalIpLimit: WORDPRESS_V2_ARTIFACT_RATE_LIMIT * 8,
  windowMs: 60 * 60 * 1000,
});
router.get(
  '/web-installations/:installationId/artifacts/:artifactHash/manifest',
  publicWebArtifactRateLimit,
  webWordpressInstallationsController.downloadArtifactManifest
);
router.get(
  '/web-installations/:installationId/artifacts/:artifactHash/envelope',
  publicWebArtifactRateLimit,
  webWordpressInstallationsController.downloadArtifactEnvelope
);
router.get(
  '/web-installations/:installationId/artifacts/:artifactHash/files/:pathToken',
  publicWebArtifactRateLimit,
  webWordpressInstallationsController.downloadArtifactFile
);

router.use(authMiddleware);
const webRateLimit = createMarketingWebRateLimiter();
const limitWebSaves = webRateLimit({ operation: 'web_draft_save', limit: 90, windowMs: 60 * 1000 });
const limitWebRevisions = webRateLimit({ operation: 'web_revision_create', limit: 12, windowMs: 10 * 60 * 1000 });
const limitWebProjects = webRateLimit({ operation: 'web_project_create', limit: 20, windowMs: 60 * 60 * 1000 });
const limitWebTemplates = webRateLimit({ operation: 'web_template_write', limit: 30, windowMs: 60 * 60 * 1000 });
const limitWebContentWrites = webRateLimit({ operation: 'web_content_write', limit: 120, windowMs: 10 * 60 * 1000 });
const limitWebContentGenerations = webRateLimit({ operation: 'web_content_generation', limit: 12, windowMs: 60 * 60 * 1000 });
const limitWebContentAcceptances = webRateLimit({ operation: 'web_content_generation_accept', limit: 60, windowMs: 60 * 60 * 1000 });
const limitWebMediaWrites = webRateLimit({ operation: 'web_media_write', limit: 60, windowMs: 60 * 60 * 1000 });
const limitWebCompiles = webRateLimit({ operation: 'web_artifact_compile', limit: 20, windowMs: 60 * 60 * 1000 });
const limitWebPublicationWrites = webRateLimit({ operation: 'web_publication_write', limit: 20, windowMs: 60 * 60 * 1000 });

// Web/CMS. `/api/web` conserva su contrato histórico de analítica y PSI;
// el dominio editorial vive bajo Marketing para evitar mezclar responsabilidades.
router.get('/web-projects', webProjectsController.listProjects);
router.post('/web-projects', limitWebProjects, webProjectsController.createProject);
router.get('/web-projects/:projectId', webProjectsController.getProject);
router.patch('/web-projects/:projectId', webProjectsController.updateProject);
router.get('/web-projects/:projectId/draft', webProjectsController.getDraft);
router.put('/web-projects/:projectId/draft', limitWebSaves, webProjectsController.saveDraft);
router.get('/web-projects/:projectId/revisions', webProjectsController.listRevisions);
router.get('/web-projects/:projectId/content-drift', webProjectsController.getContentDrift);
router.post('/web-projects/:projectId/revisions', limitWebRevisions, webProjectsController.createRevision);
router.post('/web-projects/:projectId/templates', limitWebTemplates, webProjectsController.createTemplateFromProject);
router.post('/web-revisions/:revisionId/submit', webProjectsController.submitRevision);
router.post('/web-revisions/:revisionId/approve', webProjectsController.approveRevision);
router.post('/web-revisions/:revisionId/compile', limitWebCompiles, webArtifactsController.compileRevision);
router.get('/web-artifacts/:artifactId', webArtifactsController.getArtifact);
router.get('/web-projects/:projectId/artifacts', webArtifactsController.listProjectArtifacts);
router.get('/web-projects/:projectId/publications', webPublicationsController.listProjectPublications);
router.post('/web-publications', limitWebPublicationWrites, webPublicationsController.createPublication);
router.get('/web-publications/verification-key', webPublicationsController.getVerificationKey);
router.get('/web-publications/:publicationId', webPublicationsController.getPublication);
router.get('/web-publications/:publicationId/deployments', webPublicationsController.listDeployments);
router.post('/web-publications/:publicationId/publish', limitWebPublicationWrites, webPublicationsController.requestPublish);
router.post('/web-publications/:publicationId/rollback', limitWebPublicationWrites, webPublicationsController.requestRollback);
router.post('/web-publications/:publicationId/retire', limitWebPublicationWrites, webPublicationsController.retireWordpressPublication);
router.get('/web-domains', webDomainsController.listDomains);
router.post('/web-domains', limitWebPublicationWrites, webDomainsController.createDomain);
router.post('/web-domains/:domainId/verify', limitWebPublicationWrites, webDomainsController.verifyDomain);
router.post('/web-domains/:domainId/rotate-verification', limitWebPublicationWrites, webDomainsController.rotateDomainToken);
router.get('/web-installations', webWordpressInstallationsController.listInstallations);
router.post('/web-installations', limitWebPublicationWrites, webWordpressInstallationsController.createInstallation);
router.post('/web-installations/:installationId/plugin-package', limitWebPublicationWrites, webWordpressInstallationsController.downloadPluginPackage);
router.post('/web-installations/:installationId/rotate-token', limitWebPublicationWrites, webWordpressInstallationsController.rotateToken);
router.post('/web-installations/:installationId/revoke', limitWebPublicationWrites, webWordpressInstallationsController.revokeInstallation);
router.get('/web-templates', webProjectsController.listTemplates);
router.patch('/web-templates/:templateId', limitWebTemplates, webProjectsController.updateTemplate);
router.delete('/web-templates/:templateId', limitWebTemplates, webProjectsController.archiveTemplate);
router.get('/web-content', webContentMediaController.listContent);
router.post('/web-content', limitWebContentWrites, webContentMediaController.createContent);
router.get('/web-content/generations/configuration', webContentGenerationController.getConfiguration);
router.post('/web-content/generations', limitWebContentGenerations, webContentGenerationController.createGeneration);
router.get('/web-content/generations/:generationId', webContentGenerationController.getGeneration);
router.post(
  '/web-content/generations/:generationId/accept',
  limitWebContentAcceptances,
  webContentGenerationController.acceptGeneration
);
router.get('/web-content/:contentId', webContentMediaController.getContent);
router.patch('/web-content/:contentId', limitWebContentWrites, webContentMediaController.updateContent);
router.get('/web-content/:contentId/versions', webContentMediaController.listContentVersions);
router.get('/web-media', webContentMediaController.listMedia);
router.post('/web-media', limitWebMediaWrites, webContentMediaController.registerMedia);
router.patch('/web-media/:mediaId', limitWebMediaWrites, webContentMediaController.updateMedia);

// Informes de marketing agregados (front no orquesta fuentes externas una a una)
router.get('/reports/overview', marketingReportsController.getOverview);
router.get('/reports/competition', marketingCompetitionController.getCompetition);
router.get('/reports/competition/suggestions', marketingCompetitionController.suggestCompetitors);
router.get('/reports/competition/local-heatmap/searches', marketingCompetitionController.listLocalHeatmapSearches);
router.post('/reports/competition/local-heatmap/searches', marketingCompetitionController.saveLocalHeatmapSearch);
router.delete('/reports/competition/local-heatmap/searches/:searchId', marketingCompetitionController.deleteLocalHeatmapSearch);
router.get('/reports/competition/local-heatmap', marketingCompetitionController.getLocalHeatmap);
router.post('/reports/competition/competitors', marketingCompetitionController.createCompetitor);
router.patch('/reports/competition/competitors/:competitorId', marketingCompetitionController.updateCompetitor);
router.delete('/reports/competition/competitors/:competitorId', marketingCompetitionController.deleteCompetitor);
router.post('/reports/competition/refresh', marketingCompetitionController.refreshCompetition);
router.get('/reports/competition/ai-visibility', marketingAiVisibilityController.getOverview);
router.post('/reports/competition/ai-visibility', marketingAiVisibilityController.createRun);
router.get('/reports/competition/ai-visibility/:runId', marketingAiVisibilityController.getRun);

// Read model del hub de Objetivos. Solo agrega evidencia ya persistida; no
// sincroniza proveedores ni ejecuta cambios sobre campañas o automatizaciones.
router.get('/objectives/status', marketingObjectivesController.getStatus);

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
router.get('/strategies/:id/recent-leads', campaignOnboardingController.getMarketingStrategyRecentLeads);
router.get('/strategies/:id/metrics', campaignOnboardingController.getMarketingStrategyMetrics);
router.get('/strategies/:id/destination-bindings', campaignDestinationBindingsController.listForStrategy);
router.get('/destination-bindings/:bindingId', campaignDestinationBindingsController.getBinding);
router.post('/destination-bindings/:bindingId/apply', campaignDestinationBindingsController.applyDestination);
router.post('/destination-bindings/:bindingId/rollback', campaignDestinationBindingsController.rollbackDestination);

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
