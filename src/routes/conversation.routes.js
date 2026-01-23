'use strict';
const express = require('express');
const router = express.Router();
const authMiddleware = require('./auth.middleware');
const conversationController = require('../controllers/conversation.controller');

router.use(authMiddleware);

router.get('/conversations', conversationController.listConversations);
router.get('/conversations/:id/messages', conversationController.getMessages);
router.post('/conversations/:id/messages', conversationController.postMessage);
router.patch('/conversations/:id/read', conversationController.markAsRead);

// Chat interno del equipo
router.post('/chat/internal', conversationController.createInternalMessage);

module.exports = router;
