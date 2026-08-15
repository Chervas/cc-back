'use strict';

const express = require('express');
const router = express.Router();

// Controladores
const metaSyncController = require('../controllers/metasync.controller');
const socialStatsController = require('../controllers/socialstats.controller');
const metaDiagnosticController = require('../controllers/metasync.diagnostic');
const metaJobsController = require('../controllers/metasync.jobs.controller');

// Middleware de autenticación
const authMiddleware = require('./auth.middleware');
const { isGlobalAdmin } = require('../lib/role-helpers');

// Aplicar middleware de autenticación a todas las rutas
router.use(authMiddleware);

function requireTechnicalAdmin(req, res, next) {
  if (!isGlobalAdmin(req.userData?.userId)) {
    return res.status(403).json({ success: false, error: 'technical_admin_required' });
  }
  return next();
}

// ===== RUTAS DE SINCRONIZACIÓN =====
router.post('/clinica/:clinicaId/sync', requireTechnicalAdmin, metaSyncController.syncClinica);
router.post('/asset/:assetId/sync', requireTechnicalAdmin, metaSyncController.syncAsset);
router.get('/logs', requireTechnicalAdmin, metaSyncController.getSyncLog);
router.get('/stats', requireTechnicalAdmin, metaSyncController.getSyncStats);

// ===== RUTAS DE VALIDACIÓN DE TOKENS =====
router.get('/tokens/validate', requireTechnicalAdmin, metaSyncController.validateTokens);
router.get('/tokens/validate/:connectionId', requireTechnicalAdmin, metaSyncController.validateTokenById);
router.get('/tokens/stats', requireTechnicalAdmin, metaSyncController.getTokenValidationStats);

// ===== RUTAS DE MÉTRICAS =====
router.get('/metrics/:clinicaId', metaSyncController.getMetricsByClinica);
router.get('/clinica/:clinicaId/stats', socialStatsController.getClinicaStats);
router.get('/asset/:assetId/stats', socialStatsController.getAssetStats);
router.get('/clinica/:clinicaId/posts', socialStatsController.getClinicaPosts);
router.get('/clinica/:clinicaId/organic-vs-paid', socialStatsController.getOrganicVsPaidByDay);
router.get('/clinica/:clinicaId/views-organic-vs-paid', socialStatsController.getViewsOrganicVsPaidByDay);
// Desgloses de pago (Meta Ads)
router.get('/clinica/:clinicaId/ads/paid-views-breakdown', socialStatsController.getPaidViewsBreakdown);
router.get('/clinica/:clinicaId/ads/paid-reach-breakdown', socialStatsController.getPaidReachBreakdown);
// Diagnóstico: tipos de acción (Meta Ads)
router.get('/clinica/:clinicaId/ads/action-types', socialStatsController.getAdsActionTypes);
// Salud de campañas (Meta Ads inicialmente)
router.get('/clinica/:clinicaId/ads/health', socialStatsController.getAdsHealth);
// Incidencias de atribución Ads
router.get('/ads/issues', socialStatsController.getAdsIssues);
router.post('/ads/issues/resolve', socialStatsController.resolveAdsIssue);
router.get('/post/:postId', socialStatsController.getPost);
router.get('/clinica/:clinicaId/top-posts', socialStatsController.getTopPosts);
router.get('/clinica/:clinicaId/dashboard', socialStatsController.getDashboardSummary);

// ===== RUTAS DE DIAGNÓSTICO =====
router.get('/diagnostic/user-connection', metaDiagnosticController.testUserConnection);
router.get('/diagnostic/asset/:assetId', metaDiagnosticController.testAssetConnection);
router.get('/diagnostic/permissions', metaDiagnosticController.checkPermissions);
router.get('/diagnostic/sample-data/:assetId', metaDiagnosticController.getSampleData);
router.get('/diagnostic/asset-details/:assetId', metaDiagnosticController.getAssetDetails);

// ===== RUTAS DE GESTIÓN DE JOBS CRON =====
// Toda la superficie /jobs controla infraestructura global, colas y logs. Los
// backfills clínicos ordinarios se encolan desde los endpoints OAuth que ya
// validan destinos; esta API manual queda reservada a administración técnica.
router.use('/jobs', requireTechnicalAdmin);
router.post('/jobs/initialize', metaJobsController.initializeJobs);
router.get('/jobs/status', metaJobsController.getJobsStatus);
router.post('/jobs/start', metaJobsController.startJobs);
router.post('/jobs/stop', metaJobsController.stopJobs);
router.post('/jobs/restart', metaJobsController.restartJobs);
router.post('/jobs/run/:jobName', metaJobsController.runJob);
router.post('/jobs/web/backfill', metaJobsController.runTargetedWebBackfill);
router.post('/jobs/analytics/backfill', metaJobsController.runTargetedAnalyticsBackfill);
router.get('/jobs/logs', metaJobsController.getJobsLogs);
router.get('/jobs/statistics', metaJobsController.getJobsStatistics);
router.get('/jobs/configuration', metaJobsController.getJobsConfiguration);
router.get('/jobs/next-executions', metaJobsController.getNextExecutions);
// Monitorización de uso de API y logs
router.get('/jobs/usage/meta', metaJobsController.getMetaUsageStatus);
router.get('/jobs/usage/google-ads', metaJobsController.getGoogleUsageStatus);
router.get('/jobs/usage/ai-visibility', metaJobsController.getAiVisibilityUsageStatus);
router.get('/jobs/usage/overview', metaJobsController.getApiUsageOverview);
router.post('/jobs/usage/google-ads/resume', metaJobsController.resumeGoogleUsage);
router.get('/jobs/sync-logs/:id/tail', metaJobsController.tailJobLog);
router.get('/metrics/:clinicaId', metaSyncController.getMetricsByClinica);

module.exports = router;
