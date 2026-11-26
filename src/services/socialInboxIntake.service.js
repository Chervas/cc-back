'use strict';

const { events, eventKey } = require('./socialInboxEvents');
const { resolveRoute, sameRoute } = require('./socialInboxRoute.service');
const JOB = 'quickchat_social_receive';

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
        if (!fresh && (history || e.echo)) return 'duplicate';
        if (!fresh) {
          receipt = await db.SocialInboxReceipt.findByPk(key, {
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
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
        await enqueue(
          {
            type: JOB,
            priority: 'high',
            origin: history ? 'meta_social_history' : 'meta_social_webhook',
            maxAttempts: 8,
            dedupeScope: fresh ? key : key + ':live',
            payload: { receiptKey: key, __runtime_namespace: namespace },
          },
          { transaction: t, JobRequestModel: db.JobRequest, sequelizeInstance: db.sequelize },
        );
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

module.exports = { JOB, createReceiptIntake, accept };
