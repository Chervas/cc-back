'use strict';

const express = require('express');
const router = express.Router();

const controller = require('../controllers/jobrequests.controller');
const authMiddleware = require('./auth.middleware');

router.use(authMiddleware);

router.get('/', controller.list);
router.get('/summary', controller.summary);
router.post('/', controller.create);
router.post('/:id/cancel', controller.cancel);
router.post('/:id/retry', controller.retry);
router.post('/:id/trigger', controller.trigger);
router.get('/worker/status', controller.workerStatus);

module.exports = router;
