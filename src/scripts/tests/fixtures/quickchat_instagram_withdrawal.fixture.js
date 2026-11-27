'use strict';
const assert = require('node:assert/strict');
const { events, eventKey } = require('../../../services/socialInboxEvents');

module.exports = async function verifyWithdrawal({ db, svc, dm, webhook, resolve, jobs, dispatched, packets, accounts, setDenied, setRedisDown }) {
  const appId = '123', author = '8462', secret = 'Texto sintético retirado';
  function message(mid, { sender = author, account = '501', deleted = false, delta = 0 } = {}) {
    const body = dm(account, mid, delta);
    const item = body.entry[0].messaging[0];
    item.sender.id = sender;
    item.message.text = secret;
    item.message.attachments = [{ type: 'image' }];
    if (deleted) item.message.is_deleted = true;
    return body;
  }
  const receipt = body => db.SocialInboxReceipt.findByPk(eventKey(events(body)[0]));
  const history = async body => {
    const e = events(body)[0];
    return svc.accept(body, { appId, namespace: 'dev', history: true, expectedRoute: await resolve(db, e) });
  };
  const drain = async () => { while (jobs.length) await svc.importReceipt(jobs.shift().payload.receiptKey); };
  const thread = () => db.Conversation.findOne({ where: { social_account_id: '501', contact_id: author } });
  let calls = dispatched.length;
  const mixed = message('retained-dm', { delta: -49 * 3600000 });
  const admin = { ...mixed.entry[0].messaging[0], message: { admin_text: secret, handoff_reason: 'purchase_intent' } };
  mixed.entry[0].messaging.unshift(admin, { ...admin, message: { ...admin.message, mid: 'admin-only' } });
  mixed.entry[0].messaging[2].message.admin_text = 'Contexto administrativo';
  assert.equal(events(mixed).length, 1);
  await webhook(mixed);
  assert.equal(dispatched.length, ++calls);
  const oldest = (await thread()).last_inbound_at;
  const original = message('withdraw-after');
  await webhook(original);
  assert.equal(dispatched.length, ++calls);
  const row = await receipt(original), msg = await db.Message.findByPk(row.message_id);
  await msg.update({ metadata: { ...msg.metadata, preview_text: secret, socialLead: { decision: { kind: 'opt_out', summary: secret } } } });
  const deleted = message('withdraw-after', { deleted: true });
  await webhook(deleted, true);
  await webhook(message('withdraw-after', { deleted: true, sender: '9876543' }));
  await webhook(message('withdraw-after', { deleted: true, account: '502' }));
  accounts['501'] = 42;
  await webhook(deleted);
  accounts['501'] = 41;
  assert.equal((await msg.reload()).content, secret);
  // A valid withdrawal belongs to the original signed clinic even after loss of Graph or CRM assignment.
  const wasAssigned = accounts['501'];delete accounts['501'];setDenied(true);
  await webhook(deleted, false, false);
  assert.equal(await svc.readEntry(row.key, 41), null);
  const key = jobs.shift().payload.receiptKey;
  setRedisDown(true);
  await assert.rejects(svc.importReceipt(key), /realtime_bus_unavailable/);
  assert.equal((await row.reload()).state, 'withdrawn');
  assert.equal((await db.SocialInboxReceipt.findByPk(key)).state, 'notify');
  setRedisDown(false);await svc.importReceipt(key);
  assert.equal((await db.SocialInboxReceipt.findByPk(key)).state, 'withdrawn');
  assert.equal((await msg.reload()).content, 'Mensaje retirado');
  assert.equal(msg.metadata.socialContactOptOut, true);
  assert.deepEqual(msg.metadata.socialLead, { decision: { kind: 'opt_out' } });
  assert(!JSON.stringify(msg.metadata).includes(secret));
  assert(!JSON.stringify(row.event).includes(secret));
  assert.equal(row.event.source, 'withdrawal');
  assert.equal((await thread()).last_inbound_at.getTime(), oldest.getTime());
  assert(packets.some(p => p[1] === msg.id && p[2] === 'message:updated'));
  await webhook(deleted);
  accounts['501'] = wasAssigned;setDenied(false);
  await webhook(original);await history(original);await drain();
  assert.equal((await msg.reload()).content, 'Mensaje retirado');
  assert.equal(dispatched.length, calls);

  // Tombstone before both live and historical delivery. A raw copy cannot even stay in review.
  for (const first of ['history', 'live', 'revoked']) {
    const mid = 'withdraw-before-' + first, fresh = message(mid);
    const drop = message(mid, { deleted: true });
    await webhook(drop);
    if (first === 'revoked') delete accounts['501'];
    if (first === 'history') await history(fresh); else await webhook(fresh);
    accounts['501'] = wasAssigned;
    await history(fresh);await webhook(fresh);await drain();
    const absent = await receipt(fresh);
    assert.equal(absent.state, 'withdrawn');
    assert.equal(absent.message_id, null);
    assert(!JSON.stringify(absent.event).includes(secret));
  }

  const delayed = message('withdraw-reviewed');
  setDenied(true);await webhook(delayed);
  assert.equal((await receipt(delayed)).state, 'review');
  await webhook(message('withdraw-reviewed', { deleted: true }));
  assert.equal((await receipt(delayed)).state, 'withdrawn');
  assert(!(JSON.stringify((await receipt(delayed)).event).includes(secret)));
  setDenied(false);

  const promoted = message('withdraw-promoted');
  await history(promoted);await drain();await webhook(promoted, false, false);
  await webhook(message('withdraw-promoted', { deleted: true }), false, false);
  await Promise.all(jobs.splice(0).map(j => svc.importReceipt(j.payload.receiptKey)));
  const promotedRow = await receipt(promoted);
  assert.equal(promotedRow.state, 'withdrawn');
  assert.equal((await db.Message.findByPk(promotedRow.message_id)).content, 'Mensaje retirado');
  assert.equal(dispatched.length, calls);

  for (const first of ['withdraw', 'receive']) {
    const mid = 'concurrent-' + first, delivery = message(mid), removal = message(mid, { deleted: true });
    const batch = first === 'withdraw' ? [removal, delivery] : [delivery, removal];
    await Promise.all(batch.map(body => webhook(body, false, false)));
    await Promise.all(jobs.splice(0).map(j => svc.importReceipt(j.payload.receiptKey)));
    const final = await receipt(delivery);
    assert.equal(final.state, 'withdrawn');
    assert(!JSON.stringify(final.event).includes(secret));
    assert.equal(final.message_id, null);
  }
  const noRouteMid = 'withdraw-no-route-or-original', noRouteOriginal = message(noRouteMid);
  delete accounts['501'];
  await webhook(message(noRouteMid, { deleted: true }));
  assert.equal(await receipt(noRouteOriginal), null);
  accounts['501'] = wasAssigned;
  await history(noRouteOriginal);await webhook(noRouteOriginal);await drain();
  assert.equal((await receipt(noRouteOriginal)).state, 'withdrawn');
  assert.equal((await receipt(noRouteOriginal)).message_id, null);

  const rotatedMid = 'withdraw-after-renewal', rotatedMessage = message(rotatedMid);
  await webhook(rotatedMessage);
  assert.equal(dispatched.length, ++calls);
  const reroutedJobs = [];
  const otherConnection = require('../../../services/socialInbox.service').create({
    db,
    resolve: async (...args) => ({ ...await resolve(...args), connectionRef: 'different-enrollment', enrollmentId: 'replacement' }),
    provider: { receive: () => assert.fail('an authenticated withdrawal needs no profile read') },
    publish: (c, m, type) => packets.push([c.id, m.id, type]),
    enqueue: job => reroutedJobs.push(job),
  });
  await otherConnection.accept(message(rotatedMid, { deleted: true }), { appId, namespace: 'dev', accounts: new Map([['501', 41]]) });
  const rotatedKey = reroutedJobs.shift().payload.receiptKey;
  const anchor = await db.SocialInboxReceipt.findByPk(rotatedKey);
  assert.equal(anchor.route.connectionRef, 'shared-test');
  await otherConnection.importReceipt(rotatedKey);
  assert.equal((await receipt(rotatedMessage)).state, 'withdrawn');
  const reviewedUnassigned = message('reviewed-assignment');
  delete accounts['501'];await webhook(reviewedUnassigned);
  assert.equal((await receipt(reviewedUnassigned)).state, 'review');
  accounts['501'] = wasAssigned;
  await webhook(message('reviewed-assignment', { deleted: true }));
  assert.equal((await receipt(reviewedUnassigned)).state, 'withdrawn');
  assert(!JSON.stringify((await receipt(reviewedUnassigned)).event).includes(secret));
  const spoof = message('valid-other-sender');
  await webhook(message('valid-other-sender', { deleted: true, sender: '9876543' }));
  await webhook(spoof);
  assert.equal((await receipt(spoof)).state, 'persisted');
  assert.equal(dispatched.length, ++calls);
  const ignored = dm('501', 'echo-withdrawal', 0, true);ignored.entry[0].messaging[0].message.is_deleted = true;
  await webhook(ignored);
  assert.equal(events(ignored).length, 0);
  assert.equal(dispatched.length, calls);
};
