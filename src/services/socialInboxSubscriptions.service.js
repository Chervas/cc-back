'use strict';

const { resolveEnqueueRuntimeNamespace } = require('../lib/gatewayJobOwnership');
const { graphId } = require('../../services/integrations-broker/src/meta-marketing-contract');
const { targetsFor } = require('../../services/integrations-broker/src/meta-marketing-social-consent');
const { configuredQuickChat } = require('./metaMarketingMessagingScopes');
const { resolveRoute } = require('./socialInboxRoute.service');
const C = require('./metaMarketingEnrollment.contract');

const JOB = 'quickchat_subscribe_page_messages';

async function enqueuePages(db, enrollment, versionId, transaction, {
  targets = configuredQuickChat(), env = process.env,
  enqueue = (values, options) => require('./jobRequests.service').enqueueUniqueJobRequest(values, options),
} = {}) {
  const pages = targetsFor(targets, enrollment.selected, enrollment.clinicIds).filter(row => row.channel === 'messenger');
  if (!pages.length) return;
  const current = env.JOB_RUNTIME_NAMESPACE || env.RUNTIME_NAMESPACE;
  const namespace = resolveEnqueueRuntimeNamespace(current, null, env);
  if (!namespace || namespace === 'gateway') throw Error('social_job_scope');
  for (const page of pages) {
    const enrollmentId = enrollment.enrollment_id;
    await enqueue({
      type: JOB, priority: 'normal', origin: 'meta_connection_confirmed', maxAttempts: 8,
      dedupeScope: [enrollmentId, versionId, page.pageId].join(':'),
      payload: { enrollmentId, versionId, pageId: page.pageId, clinicId: page.clinicId, __runtime_namespace: namespace },
    }, { transaction, JobRequestModel: db.JobRequest, sequelizeInstance: db.sequelize });
  }
}

async function run(db, p, {
  env = process.env, targets = configuredQuickChat(), resolve = resolveRoute,
  getProvider = () => require('./socialInboxProvider.service').provider(env),
} = {}) {
  const namespace = env.JOB_RUNTIME_NAMESPACE || env.RUNTIME_NAMESPACE;
  if (!namespace || namespace === 'gateway' || env.RUNTIME_ROLE === 'gateway' || namespace !== p?.__runtime_namespace ||
      !C.UUID.test(p.enrollmentId) || !C.UUID.test(p.versionId) || !graphId(p.pageId) || !Number.isSafeInteger(p.clinicId) || p.clinicId < 1)
    throw Error('social_job_scope');
  if (env.META_SOCIAL_INBOX_ENABLED !== 'true' || !targets.some(row => row.channel === 'messenger' &&
      row.clinicId === p.clinicId && row.pageId === p.pageId && row.accountId === p.pageId))
    return { skipped: true, reason: 'social_target_disabled' };

  try {
    // Keep the confirmed enrollment, its identity, and its destinations stable
    // while the owner checks the current credential and updates the Page.
    return await db.sequelize.transaction(async transaction => {
      const options = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
      const enrollment = await db.MetaMarketingEnrollmentRequest.findByPk(p.enrollmentId, options);
      if (enrollment?.state !== 'active') return { skipped: true, reason: 'enrollment_changed' };
      const route = await resolve(db, { channel: 'messenger', accountId: p.pageId }, transaction);
      if (!route || route.enrollmentId !== p.enrollmentId || route.clinicId !== p.clinicId || route.pageId !== p.pageId)
        return { skipped: true, reason: 'account_unassigned' };
      const pointer = await db.MetaMarketingEffectiveCredential.findByPk(p.enrollmentId, options);
      if ((pointer?.version_id || enrollment.flow_id) !== p.versionId) return { skipped: true, reason: 'credential_changed' };
      const result = await getProvider().subscribePage(route, p.versionId);
      return result.available ? { subscribed: true } : { skipped: true, reason: result.reason };
    });
  } catch (error) {
    if (error?.code === 'rate_limited' && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 && error.retryAfterMs <= 86400000)
      return { status: 'waiting', backoffMs: error.retryAfterMs, reason: 'rate_limited' };
    throw error;
  }
}

module.exports = { JOB, enqueuePages, run };
