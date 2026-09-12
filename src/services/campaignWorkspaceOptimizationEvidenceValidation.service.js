'use strict';

const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { performancePeriod, verifyPerformanceSnapshot } = require('./campaignWorkspacePerformanceSnapshot.service');
const fail = () => { throw Object.assign(new Error('workspace_optimization_evidence_invalid'), { code: 'workspace_optimization_evidence_invalid' }); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function validateOptimizationCollection(collection, now, action) {
  const { fingerprint, ...body } = collection || {};
  if (!collection || !hash(fingerprint) || fingerprint !== digest(body) || body.schema_version !== 1 || body.action !== action
    || !hash(body.source_fingerprint) || !safeDate(body.collected_at) || !safeDate(body.observed_at)
    || +new Date(body.collected_at) > +new Date(body.observed_at) || +new Date(body.observed_at) > +now
    || +now - +new Date(body.collected_at) >= 60000 || !Array.isArray(body.authorization_targets)) fail();
  const snapshot = body.performance; const { fingerprint: performanceHash, ...performanceBody } = snapshot || {};
  if (!snapshot || snapshot.schema_version !== 1 || !hash(performanceHash) || performanceHash !== digest(performanceBody)
    || snapshot.currency !== 'EUR' || digest(snapshot.period) !== digest(performancePeriod(now))
    || digest(snapshot.reference) !== digest(body.reference) || !safeDate(snapshot.observed_at)
    || +new Date(snapshot.observed_at) < +new Date(body.collected_at) || +new Date(snapshot.observed_at) > +new Date(body.observed_at)
    || !Array.isArray(snapshot.inventory) || snapshot.inventory.length > 2000
    || !Array.isArray(snapshot.ad_daily) || snapshot.ad_daily.length > 56000
    || !Array.isArray(snapshot.campaign_daily) || snapshot.campaign_daily.length > 28
    || snapshot.source !== (body.reference.provider === 'google_ads' ? 'google_ads_complete_search' : 'meta_graph_complete_insights')
    || body.attribution?.schema_version !== 1 || body.attribution.basis !== 'crm_created_at'
    || !Array.isArray(body.attribution.ad_daily) || body.attribution.ad_daily.length > 10000) fail();
  optimizationReference(body.reference);
  verifyPerformanceSnapshot(snapshot, body.reference, now);
  return body;
}

module.exports = { validateOptimizationCollection };
