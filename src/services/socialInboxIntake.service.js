'use strict';

const { events, eventKey } = require('./socialInboxEvents');
const { resolveRoute } = require('./socialInboxRoute.service');
const JOB = 'quickchat_social_receive';

function createReceiptIntake({ db, resolve = resolveRoute, enqueue }) {
  return async function accept(body, { appId, namespace, history = false }) {
    for (const e of events(body, { history }))
      await db.sequelize.transaction(async (t) => {
        const key = eventKey(e);
        const [receipt, fresh] = await db.SocialInboxReceipt.findOrCreate({
          where: { key },
          defaults: { event: e, state: 'pending' },
          transaction: t,
        });
        if (!fresh) return;
        const route = await resolve(db, e, t);
        if (!route || route.appId !== appId)
          return receipt.update({ state: 'review', reason: 'account_unassigned' }, { transaction: t });
        await receipt.update({ route }, { transaction: t });
        await enqueue(
          {
            type: JOB,
            priority: 'high',
            origin: 'meta_social_webhook',
            maxAttempts: 8,
            dedupeScope: key,
            payload: { receiptKey: key, __runtime_namespace: namespace },
          },
          { transaction: t, JobRequestModel: db.JobRequest, sequelizeInstance: db.sequelize },
        );
      });
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
