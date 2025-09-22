'use strict';

const express = require('express');
const router = express.Router();
const googleAdsController = require('../controllers/googleads.controller');
const authMiddleware = require('./auth.middleware');

router.use(authMiddleware);

router.get('/clinica/:clinicaId/overview', googleAdsController.getOverview);
router.get('/clinica/:clinicaId/timeseries', googleAdsController.getTimeseries);
router.get('/clinica/:clinicaId/campaigns', googleAdsController.getCampaigns);
router.get('/clinica/:clinicaId/health', googleAdsController.getHealth);

module.exports = router;
