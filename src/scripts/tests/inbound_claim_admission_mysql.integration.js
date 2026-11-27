'use strict';

const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const D = require('sequelize');
const migration = require('../../../migrations/20261127140000-enforce-inbound-claim-uniqueness');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = D;
  db.Message = sql.define(
    'Message',
    { conversation_id: D.INTEGER, direction: D.STRING },
    { timestamps: false }
  );
  db.Conversation = sql.define(
    'Conversation',
    { clinic_id: D.INTEGER, channel: D.STRING },
    { timestamps: false }
  );
  for (const name of ['AutomationInboundMessageClaim', 'JobRequest'])
    db[name] = require('../../../models/' + name.toLowerCase())(sql, D);
  for (const model of [db.Conversation, db.Message, db.AutomationInboundMessageClaim, db.JobRequest])
    await model.sync();
  await migration.up(sql.getQueryInterface());
  process.env.JOB_RUNTIME_NAMESPACE = 'dev';
  const scheduler = require.resolve('../../services/jobScheduler.service');
  require.cache[scheduler] = {
    id: scheduler,
    filename: scheduler,
    loaded: true,
    exports: { triggerImmediate: async () => {} },
  };
  const dispatch = require('../../services/automationInboundMessage.service');
  const conversation = await db.Conversation.create({ clinic_id: 41, channel: 'whatsapp' });
  const payload = async (providerMessageId) => ({
    conversation,
    clinicId: 41,
    channel: 'whatsapp',
    providerMessageId,
    inboundMessage: await db.Message.create({ conversation_id: conversation.id, direction: 'inbound' }),
  });
  const input = await payload('wamid.same');
  let started = 0,
    release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const attempts = await Promise.all(
    [1, 2].map(() =>
      sql.transaction(async (transaction) => {
        await db.AutomationInboundMessageClaim.count({ transaction });
        if (++started === 2) release();
        await barrier;
        return dispatch.enqueueInboundDispatch(input, { transaction });
      })
    )
  );
  assert.equal(attempts[0].claim.id, attempts[1].claim.id);
  assert.equal(attempts.filter((a) => a.created).length, 1);
  assert.equal(await db.JobRequest.count(), 1);
  assert.equal(await db.AutomationInboundMessageClaim.count(), 1);
  const collision = await payload('wamid.same');
  await assert.rejects(() => dispatch.enqueueInboundDispatch(collision), /identity_conflict/);
  await assert.rejects(() => dispatch.enqueueInboundDispatch({ ...input, clinicId: 42 }), /context_invalid/);
  assert.equal(await db.JobRequest.count(), 1);
  const next = await payload('wamid.recovered');
  let runs = 0;
  const transact = sql.transaction.bind(sql);
  sql.transaction = (...args) => {
    if (typeof args[0] === 'function' && ++runs === 1)
      return Promise.reject(
        Object.assign(Error('simulated deadlock'), { original: { code: 'ER_LOCK_DEADLOCK' } })
      );
    return transact(...args);
  };
  try {
    assert((await dispatch.enqueueInboundDispatch(next)).created);
  } finally {
    sql.transaction = transact;
  }
  assert.equal(await db.JobRequest.count(), 2);
  report.admissions = {
    concurrent: 2,
    uniqueClaims: 2,
    uniqueJobs: 2,
    scopeConflictRejected: true,
    transientRetry: true,
  };
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
