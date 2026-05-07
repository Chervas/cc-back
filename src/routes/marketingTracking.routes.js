'use strict';

const express = require('express');
const controller = require('../controllers/marketingTracking.controller');

const router = express.Router();

router.get('/r/:token', controller.redirectTrackedLink);

module.exports = router;
