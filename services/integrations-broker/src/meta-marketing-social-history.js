'use strict';

const { createHmac } = require('node:crypto');
const { cursorCodec } = require('./provider-cursor');
const { graphId } = require('./meta-marketing-contract');
const { fail } = require('./errors');

const HOURS_72 = 72 * 3600000;
const operation = 'meta.marketing.social.history.v1';
const threadId = (value) => typeof value === 'string' && /^[A-Za-z0-9:_=+/\-]{1,512}$/.test(value);
const mid = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value);

async function read({ payload, asset, context, appSecret, graph, pageToken }) {
  const { channel, kind, accountId, clinicId, start, end, cursor, participantId } = payload;
  if (
    end - start !== HOURS_72 ||
    end > Date.now() ||
    (channel !== 'instagram' && kind === 'comment') ||
    (participantId !== undefined && (channel !== 'instagram' || kind !== 'dm' || !graphId(participantId) || participantId === accountId))
  )
    fail('invalid_request');
  const scope = {
    ...context,
    assetRef: 'meta-facebook_page:' + asset.id,
    operation,
    policyVersion: JSON.stringify([
      context.policyVersion,
      context.generation,
      channel,
      kind,
      accountId,
      clinicId,
      start,
      end,
      ...(participantId ? [participantId] : []),
    ]),
  };
  const key = createHmac('sha256', appSecret)
    .update('clinicaclick/social-history/cursor/v1')
    .digest();
  const codec = cursorCodec(key);
  try {
    const root =
      kind === 'dm' ? { edge: 'conversations', id: asset.id } : { edge: 'media', id: accountId };
    const node = cursor ? JSON.parse(codec.open(cursor, scope)) : root;
    const seal = (next) => codec.seal(JSON.stringify(next), scope);
    const { edge, id, postId } = node;
    const fields = {
      conversations: 'id,updated_time',
      messages: 'id,created_time,from,to,message,attachments.limit(1){id}',
      media: 'id,comments.limit(1){id}',
      comments: 'id,from,text,timestamp,replies.limit(1){id}',
      replies: 'id,from,text,timestamp',
    };
    const instagramMessages = edge === 'messages' && channel === 'instagram';
    const seen = node.seen || 0;
    // Large Instagram inboxes can time out while Graph resolves updated_time for several threads.
    const pageLimit = edge === 'conversations' && channel === 'instagram' ? 1 : 10;
    const result = await graph(encodeURIComponent(id) + '/' + edge, pageToken, {
      fields: fields[edge],
      limit: String(instagramMessages ? 20 - seen : pageLimit),
      ...(edge === 'conversations' ? { platform: channel, ...(participantId ? { user_id: participantId } : {}) } : {}),
      ...(node.after ? { after: node.after } : {}),
    });
    if (result.rejected === 'instagram_inbox_access_disabled')
      return { available: false, reason: result.rejected };
    if (!Array.isArray(result.data)) fail('provider_failed');
    const entries = [],
      children = [];
    let omitted = 0,
      limitedThreads = 0;
    const inWindow = (at) => at >= start && at < end;
    for (const row of result.data) {
      if (edge === 'conversations') {
        if (!threadId(row.id)) fail('provider_failed');
        if (!(Date.parse(row.updated_time) < start))
          children.push(seal({ edge: 'messages', id: row.id }));
        continue;
      }
      if (edge === 'media') {
        if (!graphId(row.id)) fail('provider_failed');
        // An explicit empty first page rules out comments and their nested replies.
        const comments = row.comments;
        if (!Array.isArray(comments?.data) || comments.data.length || comments.paging?.next)
          children.push(seal({ edge: 'comments', id: row.id, postId: row.id }));
        continue;
      }
      const at = Date.parse(edge === 'messages' ? row.created_time : row.timestamp);
      if (edge === 'comments') {
        if (!graphId(row.id)) fail('provider_failed');
        // A new reply can belong to a comment and a post older than the recovery window.
        if (row.replies?.data?.length || row.replies?.paging?.next)
          children.push(seal({ edge: 'replies', id: row.id, postId }));
      }
      if (!Number.isFinite(at)) {
        omitted++;
        continue;
      }
      if (!inWindow(at)) continue;
      if (!graphId(row.from?.id)) {
        omitted++;
        continue;
      }
      if (edge === 'messages') {
        const to = row.to?.data;
        if (
          !mid(row.id) ||
          !Array.isArray(to) ||
          to.length !== 1 ||
          !graphId(to[0].id) ||
          (row.from.id !== accountId && to[0].id !== accountId)
        ) {
          omitted++;
          continue;
        }
        if (participantId && (row.from.id === accountId ? to[0].id : row.from.id) !== participantId) fail('scope_denied');
        const attached = Boolean(row.attachments?.data?.length);
        if (!row.message && !attached) {
          omitted++;
          continue;
        }
        entries.push({
          id: accountId,
          messaging: [
            {
              sender: { id: row.from.id },
              recipient: { id: to[0].id },
              timestamp: at,
              message: {
                mid: row.id,
                text: row.message || '',
                is_echo: row.from.id === accountId,
                ...(attached ? { attachments: [{ type: 'file' }] } : {}),
              },
            },
          ],
        });
      } else {
        if (!graphId(row.id) || typeof row.text !== 'string') {
          omitted++;
          continue;
        }
        entries.push({
          id: accountId,
          time: at,
          changes: [
            {
              field: 'comments',
              value: {
                id: row.id,
                media: { id: postId },
                from: {
                  id: row.from.id,
                  ...(typeof row.from.username === 'string'
                    ? { username: row.from.username.slice(0, 100) }
                    : {}),
                },
                text: row.text,
                ...(edge === 'replies' ? { parent_id: id } : {}),
              },
            },
          ],
        });
      }
    }
    let next = null;
    if (result.paging?.next) {
      if (instagramMessages && seen + result.data.length >= 20) {
        if (!result.data.some((row) => Date.parse(row.created_time) < start)) limitedThreads++;
      } else {
        const after = result.paging.cursors?.after;
        if (typeof after !== 'string' || !after || after === node.after) fail('provider_failed');
        next = seal({
          ...node,
          after,
          ...(instagramMessages ? { seen: seen + result.data.length } : {}),
        });
      }
    }
    return { available: true, entries, children, next, omitted, limitedThreads };
  } finally {
    key.fill(0);
  }
}

module.exports = { operation, HOURS_72, read };
