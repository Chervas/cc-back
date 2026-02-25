const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const metaController = require('../controllers/meta.controller');

router.use(authMiddleware);

router.get('/statuses', metaController.getStatuses);

module.exports = router;
