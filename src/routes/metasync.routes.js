// routes/metasync.routes.js
const express = require('express');
const router = express.Router();
const metaSyncController = require('../controllers/metasynccontroller');
const socialStatsController = require('../controllers/socialstatscontroller');
const authMiddleware = require('../middlewares/auth');

/**
 * Rutas para la sincronización con la API de Meta
 */

// Middleware de autenticación para todas las rutas
router.use(authMiddleware.verifyToken);

// Rutas de sincronización
router.post('/clinica/:clinicaId/sync', metaSyncController.syncClinica);
router.post('/asset/:assetId/sync', metaSyncController.syncAsset);

// Rutas de logs y estadísticas de sincronización
router.get('/logs', metaSyncController.getSyncLogs);
router.get('/stats', metaSyncController.getSyncStats);

// Rutas de validación de tokens
router.get('/tokens/validate', metaSyncController.validateTokens);
router.get('/tokens/validate/:connectionId', metaSyncController.validateTokens);
router.get('/tokens/stats', metaSyncController.getTokenValidationStats);

// Rutas de métricas de redes sociales
router.get('/clinica/:clinicaId/stats', socialStatsController.getClinicaStats);
router.get('/asset/:assetId/stats', socialStatsController.getAssetStats);
router.get('/clinica/:clinicaId/posts', socialStatsController.getClinicaPosts);
router.get('/post/:postId', socialStatsController.getPost);
router.get('/clinica/:clinicaId/top-posts', socialStatsController.getTopPosts);
router.get('/clinica/:clinicaId/dashboard', socialStatsController.getDashboardSummary);

module.exports = router;

