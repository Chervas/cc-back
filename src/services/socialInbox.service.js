'use strict';

const { eventKey, digest, mid, postLink } = require('./socialInboxEvents');
const { sameRoute, resolveRoute } = require('./socialInboxRoute.service');
const { invalidation } = require('../lib/socket-view-invalidation');
const { graphId } = require('../../services/integrations-broker/src/meta-marketing-contract');
const { JOB, createReceiptIntake } = require('./socialInboxIntake.service');
const withdrawal = require('./socialInboxWithdrawal.service');
const { applyWithdrawal } = require('./socialInboxWithdrawalImport.service');
const isSocial = (c) => ['instagram', 'messenger'].includes(c?.channel);
const attemptKey = (id) => digest('attempt', id);
const blocked = (reason) => ({ available: false, reason });
const success = { available: true, reason: null };
const timestamp = (v) => new Date(v).getTime();
function windowCheck(c, comment, now) {
  if (!isSocial(c)) return blocked('channel_unsupported');
  if (c.channel === 'messenger') return blocked('messenger_receive_only');
  if (!graphId(c.contact_id) || !graphId(c.social_account_id)) return blocked('account_unassigned');
  if (comment) {
    const e = comment.metadata?.social;
    if (
      comment.conversation_id !== c.id ||
      e?.type !== 'comment' ||
      e.source !== 'new' ||
      e.senderId !== c.contact_id ||
      e.accountId !== c.social_account_id ||
      e.channel !== c.channel
    )
      return blocked('comment_unavailable');
    if (comment.metadata.privateAttempt) return blocked('private_reply_reserved');
    if (!(timestamp(e.at) + 7 * 86400000 > now)) return blocked('comment_window_closed');
  } else if (!c.last_inbound_at || !(timestamp(c.last_inbound_at) + 86400000 > now))
    return blocked('dm_window_closed');
  return success;
}
function defaultPublish(c, m, type = 'message:created', confirmed = false) {
  const socket = require('./socket.service');
  const payload = invalidation(type, { id: m.id, conversation_id: c.id }),
    rooms = ['clinic:' + c.clinic_id];
  return confirmed ? socket.publishConfirmed(type, payload, rooms) : socket.emit(type, payload, rooms);
}
function create({
  db,
  resolve = resolveRoute,
  provider,
  enqueue,
  dispatchInbound,
  publish = defaultPublish,
  now = Date.now,
}) {
  const R = db.SocialInboxReceipt,
    M = db.Message,
    C = db.Conversation;
  const lock = (t) => ({ transaction: t, lock: t.LOCK.UPDATE });
  async function notifyReceipt(row) {
    await publish(
      { id: row.event.conversationId, clinic_id: row.route.clinicId },
      { id: row.message_id },
      row.event.source === 'withdrawal' ? 'message:updated' : 'message:created',
      true,
    );
    await R.update({ state: row.event.source === 'withdrawal' ? 'withdrawn' : 'persisted' }, { where: { key: row.key, state: 'notify' } });
  }
  const threadIdentity = (c) => ({ channel: c.channel, accountId: c.social_account_id });
  const accept = createReceiptIntake({ db, resolve, enqueue });
  async function importReceipt(key) {
    const pending = await R.findByPk(key);
    if (pending?.state === 'notify') return notifyReceipt(pending);
    if (!pending || pending.state !== 'pending') return;
    const e = pending.event,
      r = pending.route;
    if (e.source === 'withdrawal') {
      await applyWithdrawal(db, pending);
      const marker = await R.findByPk(key);
      if (marker?.state === 'notify') await notifyReceipt(marker);
      return;
    }
    if (await withdrawal.markerFor(db, e, r)) return;
    let access;
    try {
      access = await provider.receive(r, e);
    } catch (err) {
      if (
        ![
          'provider_unauthorized',
          'credential_revoked',
          'scope_denied',
          'asset_revoked',
          'connection_blocked',
        ].includes(err.code)
      )
        throw err;
      access = blocked(err.code);
    }
    if (!e.alias && access.alias) e.alias = access.alias;
    if (e.type === 'comment') {
      e.permalink = postLink(access.permalink) || e.permalink;
      if (access.commentAt) e.at = access.commentAt;
      if (access.post) e.post = access.post;
    }
    await db.sequelize.transaction(async (t) => {
      const route = await resolve(db, e, t);
      const row = await R.findByPk(key, lock(t));
      if (row.state !== 'pending' || row.event.source !== e.source) return;
      if (await withdrawal.markerFor(db, row.event, r, lock(t))) return;
      if (!sameRoute(route, r) || !access.available)
        return row.update(
          { state: 'review', reason: !sameRoute(route, r) ? 'account_changed' : access.reason },
          { transaction: t },
        );
      const identity = {
        clinic_id: r.clinicId,
        channel: e.channel,
        social_account_id: e.accountId,
        contact_id: e.senderId,
      };
      const [thread] = await C.findOrCreate({
        where: identity,
        defaults: { social_account_name: access.accountName },
        transaction: t,
      });
      const c = await C.findByPk(thread.id, lock(t));
      let m;
      if (row.message_id) {
        m = await M.findByPk(row.message_id, lock(t));
        if (!m || m.conversation_id !== c.id || m.metadata?.providerId !== e.eventId)
          throw Error('social_history_message_changed');
        await m.update({ metadata: { ...m.metadata, social: { ...e, clinicId: c.clinic_id, conversationId: c.id } } }, { transaction: t });
      }
      if (e.echo) {
        const attempt = e.attemptId && (await R.findByPk(attemptKey(e.attemptId), lock(t)));
        if (
          attempt?.event.conversationId === c.id &&
          sameRoute(attempt.route, r) &&
          attempt.message_id
        ) {
          m = await M.findByPk(attempt.message_id, lock(t));
          if (m && m.content === e.text) {
            await m.update(
              { status: 'sent', metadata: { ...m.metadata, providerId: e.eventId, outcome: 'sent' } },
              { transaction: t },
            );
            await attempt.update({ state: 'sent', reason: null }, { transaction: t });
          } else m = null;
        }
        // Some providers omit the developer metadata from the echo.
        if (!m)
          m = await M.findOne({
            where: { conversation_id: c.id, direction: 'outbound', 'metadata.providerId': e.eventId },
            transaction: t,
          });
      }
      if (!m)
        m = await M.create(
          {
            conversation_id: c.id,
            content: e.text || (e.attachmentType ? 'Archivo compartido' : ''),
            direction: e.echo ? 'outbound' : 'inbound',
            status: e.echo ? 'sent' : 'delivered',
            sent_at: new Date(e.at),
            metadata: {
              social: { ...e, clinicId: c.clinic_id, conversationId: c.id },
              providerId: e.eventId,
            },
          },
          { transaction: t },
        );
      const changes = { social_account_name: access.accountName || c.social_account_name };
      if (e.alias && !e.echo) changes.social_alias = e.alias;
      if (timestamp(e.at) > timestamp(c.last_message_at)) changes.last_message_at = new Date(e.at);
      if (e.source === 'new' && e.type === 'dm' && timestamp(e.at) > timestamp(c.last_inbound_at))
        changes.last_inbound_at = new Date(e.at);
      await c.update(changes, { transaction: t });
      await row.update(
        {
          message_id: m.id,
          state: 'notify',
          event: { ...e, clinicId: c.clinic_id, conversationId: c.id },
        },
        { transaction: t },
      );
      if (dispatchInbound && e.source === 'new' && !e.echo) {
        await dispatchInbound({entry: e, receiptKey: key, conversation: c, message: m, transaction: t});
      }
    });
    const notification = await R.findByPk(key);
    if (notification?.state === 'notify') await notifyReceipt(notification);
  }
  // A pending provider acknowledgement is reconciled separately from rendering history.
  // Give an in-flight send time to finish. A later read may retry an unresolved outcome.
  const pendingChecks = new Set();
  function scheduleReconciliation(c, m) {
    if (!m.metadata?.socialAttempt || pendingChecks.has(m.id)) return;
    pendingChecks.add(m.id);
    const created = timestamp(m.createdAt);
    const delay = Number.isFinite(created) ? Math.max(0, Math.min(30000, created + 30000 - now())) : 0;
    const timer = setTimeout(async () => {
      try { await reconcile(c, m); }
      catch (error) { console.warn('quickchat_social_reconcile_read_failed', { messageId: m.id }); }
      finally { pendingChecks.delete(m.id); }
    }, delay);
    timer.unref();
  }
  async function localContext(c) {
    if (provider.isEnabled && !provider.isEnabled()) return blocked('social_disabled');
    const route = await db.sequelize.transaction((t) => resolve(db, threadIdentity(c), t));
    return route && route.clinicId === c.clinic_id ? { ...success, route } : blocked('account_unassigned');
  }
  async function context(c, kind, { localOnly = false, prepareReply = false } = {}) {
    if (!isSocial(c)) return blocked('channel_unsupported');
    if (c.channel === 'messenger') return blocked('messenger_receive_only');
    try {
      const local = await localContext(c);
      if (!local.available || localOnly) return local;
      return { ...(await provider.availability(local.route, kind, { prepareReply })), route: local.route };
    } catch (err) {
      return blocked(
        ['provider_unauthorized', 'credential_revoked', 'scope_denied', 'operation_denied',
          'oauth_flow_busy', 'rate_limited'].includes(err.code)
          ? err.code
          : 'provider_unavailable',
      );
    }
  }
  async function availability(c, messages = [], { historyView = false } = {}) {
    // The inbox can offer composition under the current local route and window.
    // The send command always rechecks the live grant and page subscription.
    let local;
    const accessFor = kind => historyView ? (local ??= context(c, kind, { localOnly: true })) : context(c, kind);
    const pagePending = messages.find((m) => m.status === 'sending' && m.metadata?.socialAttempt);
    const unresolved =
      pagePending ||
      (await M.findOne({ where: { conversation_id: c.id, status: 'sending', direction: 'outbound' } }));
    let releasedAttempt;
    if (unresolved && historyView) scheduleReconciliation(c, unresolved);
    else if (unresolved) {
      const result = await reconcile(c, unresolved);
      if (result?.message && pagePending) Object.assign(pagePending, result.message.toJSON());
      if (result?.outcome === 'failed') releasedAttempt = result.attemptId;
    }
    const waiting = historyView ? unresolved : await M.findOne({
      where: { conversation_id: c.id, status: 'sending', direction: 'outbound' },
      attributes: ['id'],
      raw: true,
    });
    const commentRows = messages.filter((m) => m.metadata?.social?.type === 'comment');
    const reserved = commentRows.filter((m) => m.metadata.privateAttempt);
    const confirmed = reserved.length ? await R.findAll({
      where: {
        key: reserved.map((m) => attemptKey(m.metadata.privateAttempt)),
        state: 'sent',
        'event.conversationId': c.id,
      },
      attributes: ['key', [db.sequelize.json('event.commentMessageId'), 'commentId']],
      raw: true,
    }) : [];
    const sentComments = new Map(confirmed.map((r) => [Number(r.commentId), r.key]));
    const comments = {};
    let commentAccess;
    for (const m of commentRows) {
      const comment = releasedAttempt && releasedAttempt === m.metadata.privateAttempt
        ? { conversation_id: m.conversation_id, metadata: { ...m.metadata, privateAttempt: null } }
        : m;
      let a = windowCheck(c, comment, now());
      if (a.reason === 'private_reply_reserved' && sentComments.get(m.id) === attemptKey(m.metadata.privateAttempt)) {
        comments[m.id] = { ...a, outcome: 'sent' };
        continue;
      }
      if (waiting) a = blocked('reconciliation_required');
      if (a.available) {
        commentAccess ??= await accessFor('comment');
        a = commentAccess;
      }
      comments[m.id] = { available: a.available, reason: a.reason || null };
    }
    let dm = waiting ? blocked('reconciliation_required') : windowCheck(c, null, now());
    if (dm.available) dm = await accessFor('dm');
    return { dm: { available: dm.available, reason: dm.reason || null }, comments };
  }
  async function reserveAndSend(c, { attemptId, text, commentMessageId = null, actorId }, automation, image = null) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attemptId) ||
      !Number.isSafeInteger(Number(actorId)) ||
      Number(actorId) < 1 ||
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 1000 ||
      (commentMessageId !== null && (!Number.isSafeInteger(commentMessageId) || commentMessageId <= 0))
    )
      return blocked('invalid_reply');
    const key = attemptKey(attemptId),
      kind = commentMessageId ? 'comment' : 'dm';
    const command = { conversationId: c.id, actorId, text, commentMessageId, attemptId, ...(image ? { imageUrl: image.url } : {}) };
    async function replay(row) {
      if (
        !['conversationId', 'actorId', 'text', 'commentMessageId', 'imageUrl'].every(
          (k) => row.event[k] === command[k],
        )
      )
        return blocked('attempt_conflict');
      const message = await M.findByPk(row.message_id);
      return { attemptId, outcome: row.state, reason: row.reason, message };
    }
    const prior = await R.findByPk(key);
    if (prior) {
      const saved = await replay(prior);
      if (['sending', 'unknown'].includes(saved.outcome) && saved.message)
        return (await reconcile(c, saved.message)) || saved;
      return saved;
    }
    const access = await context(c, kind, { prepareReply: true });
    if (!access.available) return blocked(access.reason);
    const reservation = await db.sequelize.transaction(async (t) => {
      const route = await resolve(db, threadIdentity(c), t);
      if (!sameRoute(route, access.route) || route.clinicId !== c.clinic_id)
        return blocked('account_changed');
      const thread = await C.findByPk(c.id, lock(t));
      const previous = await R.findByPk(key, lock(t));
      if (previous) return replay(previous);
      const blockedByAutomation = automation && await automation.blockReason(t);
      if (blockedByAutomation) return blocked(blockedByAutomation);
      // Includes a committed reservation whose process died before observing Graph.
      const pending = await M.findOne({
        where: {
          conversation_id: c.id,
          status: 'sending',
          'metadata.socialAttempt': { [db.Sequelize.Op.ne]: null },
        },
        transaction: t,
      });
      if (pending) return blocked('reconciliation_required');
      const comment =
        commentMessageId &&
        (await M.findOne({ where: { id: commentMessageId, conversation_id: c.id }, ...lock(t) }));
      if (commentMessageId && !comment) return blocked('comment_unavailable');
      const window = windowCheck(thread, comment, now());
      if (!window.available) return window;
      const origin = comment?.metadata?.social;
      const m = await M.create(
        {
          conversation_id: c.id,
          direction: 'outbound',
          sender_id: actorId,
          content: text,
          message_type: image ? 'image' : 'text',
          status: 'sending',
          metadata: {
            ...(image ? { promotionImage: { url: image.url, label: image.label, key: image.key } } : {}),
            socialAttempt: attemptId,
              ...(automation ? {source: 'automations_v2', execution_id: automation.executionId} : {}),
            outcome: 'sending',
            ...(origin
              ? { commentId: origin.commentId, postId: origin.postId, permalink: origin.permalink }
              : {}),
          },
        },
        { transaction: t },
      );
      await R.create(
        {
          key,
          state: 'sending',
          event: { ...command, recipient: origin?.commentId || thread.contact_id },
          route,
          message_id: m.id,
        },
        { transaction: t },
      );
      if (comment)
        await comment.update(
          { metadata: { ...comment.metadata, privateAttempt: attemptId } },
          { transaction: t },
        );
      await thread.update({ last_message_at: new Date(now()) }, { transaction: t });
      t.afterCommit(() => publish(c, m));
      return { reserved: true, recipient: origin?.commentId || thread.contact_id, route };
    });
    if (!reservation.reserved) return reservation;
    let state = 'unknown',
      reason = 'reconciliation_required',
      sent;
    try {
      const blockedByAutomation = automation && await automation.blockReason();
      if (blockedByAutomation) {
        return settle(c, key, attemptId, commentMessageId, 'failed', blockedByAutomation);
      }
      sent = await provider.send(reservation.route, kind, reservation.recipient, text, attemptId, image?.url);
      if (!sent.available) {
        state = 'failed';
        reason = sent.reason;
      } else if (mid(sent.messageId) && sent.recipientId === c.contact_id) {
        state = 'sent';
        reason = null;
      }
    } catch {} // A lost provider acknowledgement must retain its reservation.
    return settle(c, key, attemptId, commentMessageId, state, reason, sent);
  }

  async function settle(c, key, attemptId, commentMessageId, state, reason, sent) {
    return db.sequelize.transaction(async (t) => {
      await C.findByPk(c.id, lock(t));
      const row = await R.findByPk(key, lock(t));
      if (row.state === 'sent' || row.state === 'failed')
        return {
          attemptId,
          outcome: row.state,
          reason: row.reason,
          message: await M.findByPk(row.message_id, { transaction: t }),
        };
      const m = await M.findByPk(row.message_id, lock(t));
      if (state === 'sent') {
        const echo = await R.findByPk(
          eventKey({ ...threadIdentity(c), eventId: sent.messageId }),
          lock(t),
        );
        if (
          echo?.event.echo &&
          echo.event.conversationId === c.id &&
          echo.message_id &&
          echo.message_id !== m.id
        ) {
          const copy = await M.findByPk(echo.message_id, lock(t));
          if (copy?.metadata?.social?.echo && copy.metadata.providerId === sent.messageId) {
            await echo.update({ message_id: m.id }, { transaction: t });
            await copy.destroy({ transaction: t });
          }
        }
      }
      await row.update({ state, reason }, { transaction: t });
      await m.update(
        {
          status: state === 'unknown' ? 'sending' : state,
          sent_at: state === 'sent' ? new Date(now()) : null,
          metadata: {
            ...m.metadata,
            outcome: state,
            reason,
            providerId: state === 'sent' ? sent.messageId : null,
          },
        },
        { transaction: t },
      );
      if (state === 'failed' && commentMessageId) {
        const comment = await M.findByPk(commentMessageId, lock(t));
        if (comment.metadata.privateAttempt === attemptId)
          await comment.update(
            { metadata: { ...comment.metadata, privateAttempt: null } },
            { transaction: t },
          );
      }
      t.afterCommit(() => publish(c, m, 'message:updated'));
      return { attemptId, outcome: state, reason, message: m };
    });
  }
  async function reconcile(c, m) {
    const id = m.metadata?.socialAttempt;
    const row = id && (await R.findByPk(attemptKey(id)));
    if (!row || row.event.conversationId !== c.id || !['unknown', 'sending'].includes(row.state)) return;
    const route = await db.sequelize.transaction((t) => resolve(db, threadIdentity(c), t));
    if (!sameRoute(row.route, route)) return;
    let proof;
    try {
      proof = await provider.reconcile(
        route,
        row.event.commentMessageId ? 'comment' : 'dm',
        row.event.recipient,
        row.event.text,
        id,
        row.event.imageUrl,
      );
    } catch {
      return;
    }
    if (proof.available && mid(proof.messageId) && proof.recipientId === c.contact_id) {
      return settle(c, row.key, id, row.event.commentMessageId, 'sent', null, proof);
    }
    if (
      proof.available === false &&
      proof.reason !== 'reconciliation_required' &&
      proof.reason !== 'social_disabled'
    ) {
      return settle(c, row.key, id, row.event.commentMessageId, 'failed', proof.reason, proof);
    }
  }
  async function reply(c, command, automation) {
    const result = await reserveAndSend(c, command, automation);
    return result.available === false
      ? { ...result, outcome: 'blocked', attemptId: command.attemptId }
      : result;
  }
  async function replyWithPromotionImage(c, command, automation) {
    if (c.channel !== 'instagram' || command.commentMessageId || typeof automation?.blockReason !== 'function'
        || !Number.isSafeInteger(automation.executionId) || command.selection?.executionId !== automation.executionId) return blocked('invalid_reply');
    const { resolveForTurn } = require('./leadAssistantPromotionImages.service');
    const image = await resolveForTurn(db, c, command.selection);
    if (!image) return blocked('promotion_image_unavailable');
    const result = await reserveAndSend(c, { ...command, text: image.label }, { ...automation,
      blockReason: async transaction => {
        const reason = await automation.blockReason(transaction);
        if (reason) return reason;
        const current = await resolveForTurn(db, c, command.selection, transaction);
        return current?.url === image.url ? null : 'promotion_image_unavailable';
      },
    }, { ...image, key: command.selection.key });
    return result.available === false ? { ...result, outcome: 'blocked', attemptId: command.attemptId } : result;
  }
  async function readEntry(key, clinicId, transaction) {
    if (!/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(clinicId) || clinicId < 1) return null;
    const receipt = await R.findByPk(key, {
      raw: true,
      attributes: ['key', 'state', 'event', 'route', 'message_id'], transaction,
    });
    if (
      !receipt || receipt.event.source === 'withdrawal' ||
      !['notify', 'persisted'].includes(receipt.state) ||
      receipt.event.clinicId !== clinicId
    )
      return null;
    if (await withdrawal.markerFor(db, receipt.event, receipt.route, { transaction })) return null;
    return { ...receipt.event, receiptKey: receipt.key, messageId: receipt.message_id };
  }
  return { accept, importReceipt, availability, reply, replyWithPromotionImage, readEntry };
}
let singleton;
function service() {
  return (singleton ||= create({
    db: require('../../models'),
    provider: require('./socialInboxProvider.service').provider(),
    enqueue: require('./jobRequests.service').enqueueUniqueJobRequest,
    dispatchInbound: event => require('./socialLeadAutomation.service').enqueue(event),
  }));
}
module.exports = { create, service, isSocial, windowCheck, JOB };
