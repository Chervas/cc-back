const express = require('express');
const authMiddleware = require('./auth.middleware');
const metaController = require('../controllers/meta.controller');

const router = express.Router();

router.use(authMiddleware);
router.get('/statuses', metaController.getStatuses);

module.exports = router;
