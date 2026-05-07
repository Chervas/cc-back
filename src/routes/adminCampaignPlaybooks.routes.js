'use strict';

const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/adminCampaignPlaybooks.controller');

router.use(authMiddleware);

router.get('/', controller.listPlaybooks);
router.get('/bulk-send-settings', controller.getBulkSendSettings);
router.put('/bulk-send-settings', controller.updateBulkSendSettings);
router.get('/:id', controller.getPlaybookById);
router.post('/', controller.createPlaybook);
router.put('/:id', controller.updatePlaybook);
router.delete('/:id', controller.deletePlaybook);

module.exports = router;
