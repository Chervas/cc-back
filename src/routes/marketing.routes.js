const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const marketingFlowsController = require('../controllers/marketingFlows.controller');
const chatFlowTemplatesController = require('../controllers/chatFlowTemplates.controller');

router.use(authMiddleware);

router.get('/flows', marketingFlowsController.listFlows);
router.get('/flows/:id', marketingFlowsController.getFlow);
router.post('/flows', marketingFlowsController.createFlow);
router.put('/flows/:id', marketingFlowsController.updateFlow);
router.delete('/flows/:id', marketingFlowsController.deleteFlow);

// Catálogo de plantillas de flujos de chat (snippet web)
router.get('/chat-flow-templates', chatFlowTemplatesController.listChatFlowTemplates);
router.get('/chat-flow-templates/:id', chatFlowTemplatesController.getChatFlowTemplate);
router.post('/chat-flow-templates', chatFlowTemplatesController.createChatFlowTemplate);
router.put('/chat-flow-templates/:id', chatFlowTemplatesController.updateChatFlowTemplate);
router.delete('/chat-flow-templates/:id', chatFlowTemplatesController.deleteChatFlowTemplate);
router.post('/chat-flow-templates/:id/duplicate', chatFlowTemplatesController.duplicateChatFlowTemplate);

module.exports = router;
