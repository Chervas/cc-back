'use strict';

const express = require('express');
const authMiddleware = require('./auth.middleware');
const publicMediaController = require('../controllers/publicMedia.controller');
const { createMarketingWebRateLimiter } = require('../lib/marketingWebRequestGuards');

const router = express.Router();

router.use(authMiddleware);

const webRateLimit = createMarketingWebRateLimiter();
const limitWebEditorUploads = webRateLimit({
  operation: 'web_media_upload',
  limit: 30,
  windowMs: 60 * 60 * 1000,
});
const limitOnlyWebEditorUploads = (req, res, next) => {
  const purpose = String(req.body?.purpose || '').trim().toLowerCase();
  return purpose === 'web_editor_media' ? limitWebEditorUploads(req, res, next) : next();
};

router.get('/status', publicMediaController.getStatus);
router.post('/upload', limitOnlyWebEditorUploads, publicMediaController.upload);

module.exports = router;
