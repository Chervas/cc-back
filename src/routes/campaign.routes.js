const express = require('express');
const router = express.Router();
const protect = require('./auth.middleware');
const campaignController = require('../controllers/campaign.controller');

router.use(protect);

router.get('/', campaignController.listCampaigns);
router.post('/', campaignController.createCampaign);
router.patch('/:id', campaignController.updateCampaign);

module.exports = router;
