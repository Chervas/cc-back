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

// Aplicar middleware de autenticación a todas las rutas
router.use(authMiddleware);

// ===== RUTAS DE SINCRONIZACIÓN =====
router.post('/clinica/:clinicaId/sync', metaSyncController.syncClinica);
router.post('/asset/:assetId/sync', metaSyncController.syncAsset);
router.get('/logs', metaSyncController.getSyncLog);
router.get('/stats', metaSyncController.getSyncStats);

// ===== RUTAS DE VALIDACIÓN DE TOKENS =====
router.get('/tokens/validate', metaSyncController.validateTokens);
router.get('/tokens/validate/:connectionId', metaSyncController.validateTokenById);
router.get('/tokens/stats', metaSyncController.getTokenValidationStats);

// ===== RUTAS DE MÉTRICAS =====
router.get('/metrics/:clinicaId', metaSyncController.getMetricsByClinica);
router.get('/clinica/:clinicaId/stats', socialStatsController.getClinicaStats);
router.get('/asset/:assetId/stats', socialStatsController.getAssetStats);
router.get('/clinica/:clinicaId/posts', socialStatsController.getClinicaPosts);
router.get('/clinica/:clinicaId/organic-vs-paid', socialStatsController.getOrganicVsPaidByDay);
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
router.post('/jobs/initialize', metaJobsController.initializeJobs);
router.get('/jobs/status', metaJobsController.getJobsStatus);
router.post('/jobs/start', metaJobsController.startJobs);
router.post('/jobs/stop', metaJobsController.stopJobs);
router.post('/jobs/restart', metaJobsController.restartJobs);
router.post('/jobs/run/:jobName', metaJobsController.runJob);
router.get('/jobs/logs', metaJobsController.getJobsLogs);
router.get('/jobs/statistics', metaJobsController.getJobsStatistics);
router.get('/jobs/configuration', metaJobsController.getJobsConfiguration);
router.get('/jobs/next-executions', metaJobsController.getNextExecutions);
router.get('/metrics/:clinicaId', metaSyncController.getMetricsByClinica);

module.exports = router;
