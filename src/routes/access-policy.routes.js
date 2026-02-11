const express = require('express');
const router = express.Router();

const authMiddleware = require('./auth.middleware');
const accessPolicyController = require('../controllers/accessPolicy.controller');

router.use(authMiddleware);

router.get('/overrides', accessPolicyController.getOverrides);
router.put('/overrides', accessPolicyController.upsertOverride);

module.exports = router;

