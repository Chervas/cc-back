'use strict';

const { randomUUID } = require('node:crypto');
const { events, eventKey } = require('./socialInboxEvents');
const { resolveRoute, sameRoute } = require('./socialInboxRoute.service');
const JOB = 'quickchat_social_receive';

const recoverableReasons = new Set([
  'permission:instagram_basic', 'permission:instagram_manage_comments', 'permission:instagram_manage_messages',
  'permission:pages_messaging', 'permission:pages_manage_metadata', 'permission:pages_read_engagement',
  'subscription:messages', 'subscription:comments', 'page_messaging_task', 'provider_unauthorized',
  'scope_denied', 'credential_revoked', 'connection_blocked',
]);

async function queueReceipt(db, enqueue, key, namespace, origin, dedupeScope, t) {
  await enqueue({
    type: JOB, priority: 'high', origin, maxAttempts: 8, dedupeScope,
    payload: { receiptKey: key, __runtime_namespace: namespace },
  }, { transaction: t, JobRequestModel: db.JobRequest, sequelizeInstance: db.sequelize });
}

async function requeueLocked(db, enqueue, receipt, route, namespace, t) {
  if (receipt?.state !== 'review' || receipt.message_id != null || !recoverableReasons.has(receipt.reason) ||
      !sameRoute(receipt.route, route) || receipt.key !== eventKey(receipt.event) ||
      receipt.event.accountId !== route.accountId || receipt.event.channel !== route.channel)
    return false;

  // Keep the signed event and the original routing decision. The normal worker
  // checks both its current assignment and live provider permissions before publishing.
  await receipt.update({ state: 'pending', reason: null }, { transaction: t });
  // An earlier worker can still be finishing its job after marking the row for
  // review. The row lock deduplicates this transition; give its new job its own scope.
  await queueReceipt(db, enqueue, receipt.key, namespace, 'meta_social_recovery',
    receipt.key + ':review:' + randomUUID(), t);
  return true;
}

async function retryReviewedReceipt(db, key, { clinicId, channel, accountId, namespace },
  { resolve = resolveRoute, enqueue = require('./jobRequests.service').enqueueUniqueJobRequest } = {}) {
  return db.sequelize.transaction(async t => {
    const route = await resolve(db, { channel, accountId }, t);
    if (!route || route.clinicId !== clinicId) return false;
    const receipt = await db.SocialInboxReceipt.findByPk(key, { transaction: t, lock: t.LOCK.UPDATE });
    return requeueLocked(db, enqueue, receipt, route, namespace, t);
  });
}

function createReceiptIntake({ db, resolve = resolveRoute, enqueue }) {
  return async function accept(body, { appId, namespace, history = false, expectedRoute, accounts }) {
    const counts = { queued: 0, duplicate: 0, review: 0 };
    for (const e of events(body, { history })) {
      const result = await db.sequelize.transaction(async (t) => {
        const historyRoute = history && expectedRoute ? await resolve(db, e, t) : null;
        if (expectedRoute && !sameRoute(historyRoute, expectedRoute))
          throw Error('social_history_route_changed');
        const key = eventKey(e);
        let [receipt, fresh] = await db.SocialInboxReceipt.findOrCreate({
          where: { key },
          defaults: { event: e, state: 'pending' },
          transaction: t,
        });
        if (!fresh && ((history && !expectedRoute) || (!history && e.echo))) return 'duplicate';
        if (!fresh) {
          receipt = await db.SocialInboxReceipt.findByPk(key, {
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
          if (history) {
            const saved = receipt.event;
            const matches = historyRoute?.appId === appId && saved.senderId === e.senderId && saved.type === e.type &&
              saved.echo === e.echo && saved.postId === e.postId && saved.commentId === e.commentId;
            if (matches && await requeueLocked(db, enqueue, receipt, historyRoute, namespace, t)) return 'queued';
            return 'duplicate';
          }
          if (
            receipt.event.source !== 'history' ||
            receipt.event.echo ||
            receipt.event.senderId !== e.senderId ||
            receipt.event.type !== e.type ||
            receipt.event.postId !== e.postId
          )
            return 'duplicate';
        }
        const route = historyRoute || (await resolve(db, e, t));
        if (!fresh && (!sameRoute(route, receipt.route) || route.appId !== appId))
          return 'duplicate';
        if (!route || route.appId !== appId || (accounts && accounts.get(e.accountId) !== route.clinicId)) {
          await receipt.update(
            { state: 'review', reason: 'account_unassigned' },
            { transaction: t },
          );
          return 'review';
        }
        await receipt.update(fresh ? { route } : { event: e, state: 'pending', reason: null }, {
          transaction: t,
        });
        await queueReceipt(db, enqueue, key, namespace, history ? 'meta_social_history' : 'meta_social_webhook',
          fresh ? key : key + ':live', t);
        return 'queued';
      });
      counts[result]++;
    }
    return counts;
  };
}

function accept(body, options) {
  const intake = createReceiptIntake({
    db: require('../../models'),
    enqueue: require('./jobRequests.service').enqueueUniqueJobRequest,
  });
  return intake(body, options);
}

module.exports = { JOB, createReceiptIntake, retryReviewedReceipt, accept };
