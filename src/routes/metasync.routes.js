'use strict';
const express = require('express');
const router = express.Router();
const metaSyncController = require('../controllers/metasync.controller');
const socialStatsController = require('../controllers/socialstats.controller');
const authMiddleware = require('./auth.middleware');

// Aplicar middleware de autenticación a todas las rutas
router.use(authMiddleware);

// Rutas de sincronización
router.post('/clinica/:clinicaId/sync', metaSyncController.syncClinica);
router.post('/asset/:assetId/sync', metaSyncController.syncAsset);
router.get('/logs', metaSyncController.getSyncLogs);
router.get('/stats', metaSyncController.getSyncStats);

// Rutas de validación de tokens
router.get('/tokens/validate', metaSyncController.validateTokens);
router.get('/tokens/validate/:connectionId', metaSyncController.validateTokenById);
router.get('/tokens/stats', metaSyncController.getTokenValidationStats);

// Rutas de métricas
router.get('/clinica/:clinicaId/stats', socialStatsController.getClinicaStats);
router.get('/asset/:assetId/stats', socialStatsController.getAssetStats);
router.get('/clinica/:clinicaId/posts', socialStatsController.getClinicaPosts);
router.get('/post/:postId', socialStatsController.getPost);
router.get('/clinica/:clinicaId/top-posts', socialStatsController.getTopPosts);
router.get('/clinica/:clinicaId/dashboard', socialStatsController.getDashboardSummary);

module.exports = router;

