'use strict';

const asyncHandler = require('express-async-handler');
const {
  requireReadAccess,
  resolveRequestedScope,
} = require('./campaignOptimization.controller');
const marketingObjectiveStatusService = require('../services/marketingObjectiveStatus.service');

const getStatus = asyncHandler(async (req, res) => {
  const scope = resolveRequestedScope(req.query);
  const clinicIds = await requireReadAccess(req, scope);
  const result = await marketingObjectiveStatusService.getMarketingObjectiveStatus({
    ...scope,
    clinicIds,
  });
  res.set('Cache-Control', 'no-store');
  res.json(result);
});

module.exports = { getStatus };
