'use strict';

const drafts = require('../services/googleReviewAiDraft.service');
const settings = require('../services/reviewReplySettings.service');
const SETTINGS_ERRORS = new Set(['technical_admin_required', 'review_reply_settings_invalid', 'review_reply_settings_version_conflict']);

function handler(work) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(await work(req)); }
    catch (error) {
      // Never forward provider messages, prompts, SDK errors or model output.
      const safe = SETTINGS_ERRORS.has(error?.code) ? { code: error.code, status: error.status }
        : drafts.safeError(error);
      if (safe.retryAfter) res.set('Retry-After', String(safe.retryAfter));
      return res.status(safe.status).json({ success: false, error: safe.code });
    }
  };
}

module.exports = {
  status: handler(() => drafts.status()),
  generate: handler(req => drafts.generate({ clinicId: req.params.clinicaId, reviewId: req.params.reviewId,
    userId: req.userData?.userId, input: req.body, request: req })),
  getSettings: handler(req => settings.get(req.userData?.userId)),
  putSettings: handler(req => settings.put(req.body, req.userData?.userId)),
};
