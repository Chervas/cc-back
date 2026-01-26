const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const marketingFlowsController = require('../controllers/marketingFlows.controller');

router.use(authMiddleware);

router.get('/flows', marketingFlowsController.listFlows);
router.get('/flows/:id', marketingFlowsController.getFlow);
router.post('/flows', marketingFlowsController.createFlow);
router.put('/flows/:id', marketingFlowsController.updateFlow);
router.delete('/flows/:id', marketingFlowsController.deleteFlow);

module.exports = router;
