'use strict';

const asyncHandler = require('express-async-handler');
const { loadAdSharing } = require('../services/adSharing.service');

function createAdSharingHandler({ models, resolveScope, hasAccess, load = loadAdSharing } = {}) {
  return async (req, res) => {
    const userId = Number(req.userData?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ success: false, error: 'unauthenticated' });
    if (typeof req.query.scope !== 'string' || !/^[1-9]\d*$/.test(req.query.scope)) return res.status(400).json({ success: false, error: 'single_clinic_scope_required' });
    const { scope: requestedScope, ...input } = req.query;
    if (Object.keys(input).some(key => !['purpose', 'lead_id', 'page', 'search', 'active_only'].includes(key))) return res.status(400).json({ success: false, error: 'invalid_ad_sharing_request' });
    const scope = await (resolveScope || require('../lib/clinicScope').resolveClinicScope)(requestedScope);
    if (!scope.isValid || scope.notFound || scope.clinicIds?.length !== 1) return res.status(404).json({ success: false, error: 'scope_not_found' });
    const access = hasAccess || require('../lib/marketingScopeAccess').hasMarketingClinicScopeAccess;
    if (!await access({ userId, clinicIds: scope.clinicIds, access: 'read' })) return res.status(403).json({ success: false, error: 'marketing_scope_forbidden' });
    res.set('Cache-Control', 'private, no-store');
    try {
      const result = await load({ models: models || require('../../models'), scope, input });
      if (!await access({ userId, clinicIds: scope.clinicIds, access: 'read' })) return res.status(403).json({ success: false, error: 'marketing_scope_forbidden' });
      return res.json(result);
    } catch (error) {
      if (error.status >= 400 && error.status < 500) return res.status(error.status).json({ success: false, error: error.code });
      throw error;
    }
  };
}

module.exports = { createAdSharingHandler, getAdSharing: asyncHandler(createAdSharingHandler()) };
