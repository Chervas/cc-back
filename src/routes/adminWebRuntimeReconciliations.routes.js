'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/adminWebRuntimeReconciliations.controller');

const router = express.Router();
router.use(authMiddleware);
router.post('/:reconciliationId/recover', controller.recoverFailedReconciliation);

module.exports = router;
