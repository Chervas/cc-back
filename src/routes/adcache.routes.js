const express = require('express');
const router = express.Router();
const adCacheController = require('../controllers/adcache.controller');
const { protect } = require('./auth.middleware');

// Rutas protegidas que requieren autenticación
//router.use(protect);

// Rutas para AdCache
router.route('/')
  .get(adCacheController.getAllAdCache)
  .post(adCacheController.createOrUpdateAdCache);

// Ruta para actualización por lotes
router.route('/batch')
  .post(adCacheController.batchUpdateAdCache);

module.exports = router;
