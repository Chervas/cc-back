const express = require('express');
const router = express.Router();
const campanaController = require('../controllers/campana.controller');

// Rutas para campañas
router.get('/', campanaController.getAllCampanas);
router.get('/:id', campanaController.getCampanaById);
router.post('/', campanaController.createCampana);
router.put('/:id', campanaController.updateCampana);
router.delete('/:id', campanaController.deleteCampana);

// Rutas adicionales específicas
router.get('/by-clinica/:clinicaId', campanaController.getCampanasByClinica);
router.post('/sync-facebook', campanaController.syncFacebookCampaigns);
router.get('/stats/summary', campanaController.getCampanasStats);

module.exports = router;
