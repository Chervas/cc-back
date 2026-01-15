const express = require('express');
const router = express.Router();
const protect = require('./auth.middleware');
const campaignRequestController = require('../controllers/campaignRequest.controller');

router.use(protect);

router.post('/', campaignRequestController.createRequest);
router.get('/', campaignRequestController.listRequests);

module.exports = router;
