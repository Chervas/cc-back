const express = require('express');
const router = express.Router();
const gruposController = require('../controllers/gruposclinicas.controller');
const authMiddleware = require('./auth.middleware');

router.use(authMiddleware);

router.get('/', gruposController.getAllGroups);
router.post('/', gruposController.createGroup);
router.patch('/:id', gruposController.updateGroup);
router.get('/:id/ads-config', gruposController.getAdsConfig);
router.delete('/:id', gruposController.deleteGroup);

module.exports = router;
