'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { resolveClinicScope } = require('../lib/clinicScope');
const { getAccessibleMarketingClinicIds, hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { loadCampaignWorkspace } = require('../services/campaignWorkspace.service');

function createWorkspaceHandler({ models = db, resolveScope = resolveClinicScope,
  accessibleClinics = getAccessibleMarketingClinicIds, hasAccess = hasMarketingClinicScopeAccess,
  load = loadCampaignWorkspace } = {}) {
  return async (req, res) => {
    const userId = Number(req.userData?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(401).json({ success: false, error: 'unauthenticated' });
    const raw = String(req.query.scope || '').trim();
    if (!/^(all|group:[1-9]\d*|[1-9]\d*(,[1-9]\d*)*)$/.test(raw)) return res.status(400).json({ success: false, error: 'invalid_scope' });
    const days = Number(req.query.days ?? 30);
    if (![7, 30].includes(days)) return res.status(400).json({ success: false, error: 'invalid_period' });
    const scope = await resolveScope(raw, { allowAll: true });
    if (scope.notFound) return res.status(404).json({ success: false, error: 'scope_not_found' });
    if (!scope.isValid) return res.status(400).json({ success: false, error: 'invalid_scope' });
    if (scope.isAll) scope.clinicIds = await accessibleClinics({ userId, clinicIds: scope.clinicIds, access: 'read' });
    if (!scope.clinicIds.length || !await hasAccess({ userId, clinicIds: scope.clinicIds, access: 'read' })) {
      return res.status(403).json({ success: false, error: 'marketing_scope_forbidden' });
    }
    res.set('Cache-Control', 'private, no-store');
    return res.json(await load({ models, scope, days }));
  };
}

exports.getWorkspace = asyncHandler(createWorkspaceHandler());
exports.createWorkspaceHandler = createWorkspaceHandler;
