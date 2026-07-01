'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const publicMediaController = require('../controllers/publicMedia.controller');

const router = express.Router();

router.use(authMiddleware);

router.get('/status', publicMediaController.getStatus);
router.post('/upload', publicMediaController.upload);

module.exports = router;
