'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const controller = require('../controllers/sendQueues.controller');

const router = express.Router();
router.use(authMiddleware);
router.get('/', controller.list);
router.post('/:queueId/pause', controller.pause);
router.post('/:queueId/resume', controller.resume);

module.exports = router;
