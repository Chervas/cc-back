'use strict';

const { digest, eventKey } = require('./socialInboxEvents');

const incomingDm = e => e?.type === 'dm' && e.channel === 'instagram' && e.echo === false;
function withdrawalKey(e, r) {
  return digest('withdrawal', r.appId, r.clinicId, r.channel, r.accountId, e.senderId, e.eventId);
}
function sameSignedScope(a, b) {
  return !!a && !!b && ['appId', 'clinicId', 'channel', 'accountId'].every(key => a[key] === b[key]);
}
function matches(e, other) {
  return incomingDm(e) && incomingDm(other) && e.eventId === other.eventId &&
    e.channel === other.channel && e.accountId === other.accountId && e.senderId === other.senderId;
}
function withdrawnEvent(e) {
  return { version: 1, channel: e.channel, accountId: e.accountId, senderId: e.senderId,
    eventId: e.eventId, type: 'dm', echo: false, source: 'withdrawal', text: '', at: e.at };
}
async function markerFor(db, e, route, options) {
  if (!incomingDm(e) || !route) return null;
  const marker = await db.SocialInboxReceipt.findByPk(withdrawalKey(e, route), options);
  return marker && marker.event.source === 'withdrawal' && matches(e, marker.event) && sameSignedScope(route, marker.route) ? marker : null;
}

// Account and clinic are independently mapped by the broker before intake.
// A withdrawal grants no access to a conversation or to a provider operation.
async function signedMarker(db, e, appId, clinicId, transaction) {
  if (!clinicId) return null;
  return markerFor(db, e, { appId, clinicId, accountId: e.accountId, channel: e.channel },
    { transaction, lock: transaction.LOCK.UPDATE });
}

async function queueWithdrawal(db, e, { appId, accounts }, resolve, queue, t) {
  const clinic = accounts?.get(e.accountId);
  if (!clinic) return 'review';
  const opts = { transaction: t, lock: t.LOCK.UPDATE };
  const original = await db.SocialInboxReceipt.findByPk(eventKey(e), opts);
  const live = await resolve(db, e, t);
  const signed = { appId, clinicId: clinic, channel: e.channel, accountId: e.accountId };
  if (live && !sameSignedScope(live, signed)) return 'review';
  // Renewals do not change the sender, physical Instagram account or message ID.
  // Keep the original full route if it exists and keep only the signed scope if no route exists yet.
  const originalRoute = matches(original?.event, e) && sameSignedScope(original.route, signed) && original.route;
  const route = originalRoute || live || signed;
  const key = withdrawalKey(e, route);
  const [, fresh] = await db.SocialInboxReceipt.findOrCreate({ where: { key },
    defaults: { route, event: e, state: 'pending' }, transaction: t });
  if (!fresh) return 'duplicate';
  await queue(key);
  return 'queued';
}

module.exports = { incomingDm, matches, sameSignedScope, withdrawalKey, withdrawnEvent, markerFor, signedMarker, queueWithdrawal };
