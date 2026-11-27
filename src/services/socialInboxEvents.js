'use strict';

const { createHash } = require('node:crypto');
const { graphId } = require('../../services/integrations-broker/src/meta-marketing-contract');
const invalid = () => {
  throw Object.assign(Error('social_invalid_event'), { code: 'social_invalid_event' });
};
const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const mid = (s) => typeof s === 'string' && /^[\x21-\x7e]{1,512}$/.test(s);
function postLink(url) {
  try {
    const u = new URL(url);
    if (
      u.protocol === 'https:' &&
      ['instagram.com', 'www.instagram.com'].includes(u.host) &&
      !u.username &&
      !u.password &&
      /^\/(?:[a-zA-Z0-9._]{1,30}\/)?(?:p|reel|tv)\/[\w-]+\/?$/.test(u.pathname)
    )
      return u.origin + u.pathname;
  } catch {}
  return null;
}

function commentAd(media) {
  const ad = {};
  if (graphId(media.ad_id)) ad.id = media.ad_id;
  if (typeof media.ad_title === 'string' && media.ad_title.trim()) ad.title = media.ad_title.trim().slice(0, 512);
  if (graphId(media.original_media_id)) ad.originalMediaId = media.original_media_id;
  return Object.keys(ad).length || media.media_product_type === 'AD' ? ad : null;
}
function events(body, { history = false } = {}) {
  const channel = { instagram: 'instagram', page: 'messenger' }[body?.object];
  if (!channel || !Array.isArray(body.entry) || !body.entry.length) invalid();
  const result = [];
  for (const e of body.entry) {
    if (!graphId(e.id)) invalid();
    function add(type, id, sender, timestamp, text, extra) {
      const ms = Number(timestamp) * (Number(timestamp) < 1e12 ? 1000 : 1);
      if (
        !mid(id) ||
        !graphId(sender) ||
        !Number.isSafeInteger(ms) ||
        ms <= 0 ||
        ms > Date.now() + 300000 ||
        typeof text !== 'string' ||
        Buffer.byteLength(text) > 64000
      )
        invalid();
      result.push({
        version: 1,
        channel,
        accountId: e.id,
        eventId: id,
        senderId: sender,
        type,
        text,
        at: new Date(ms).toISOString(),
        source: history ? 'history' : extra.echo ? 'echo' : 'new',
        ...extra,
      });
    }
    for (const item of e.messaging || []) {
      const m = item.message;
      if (!m) continue; // delivery/read receipts do not start conversations
      const echo = m.is_echo === true || item.sender?.id === e.id;
      if ((echo ? item.sender?.id : item.recipient?.id) !== e.id) invalid();
      if (channel === 'instagram' && m.is_deleted === true) {
        if (!history && !echo) add('dm', m.mid, item.sender?.id, item.timestamp, '', { echo: false, source: 'withdrawal' });
        continue;
      }
      if (channel === 'instagram' && typeof m.admin_text === 'string' &&
          (!m.mid || !(m.text || m.attachments?.length || m.is_unsupported || m.quick_reply || m.reply_to || m.referral))) continue;
      add('dm', m.mid, echo ? item.recipient?.id : item.sender?.id, item.timestamp, m.text ?? '', {
        echo,
        alias: null,
        replyTo: mid(m.reply_to?.mid) ? m.reply_to.mid : null,
        attemptId:
          echo && /^cc-social:[0-9a-f-]{36}$/.test(m.metadata || '') ? m.metadata.slice(10) : null,
        attachmentType: m.attachments?.[0]?.type?.slice(0, 32) || null,
      });
    }
    for (const change of e.changes || []) {
      if (channel === 'messenger' && change.field === 'leadgen') continue;
      if (channel !== 'instagram' || change.field !== 'comments') invalid();
      const v = change.value;
      if (!graphId(v?.media?.id) || !graphId(v.id)) invalid();
      const ad = commentAd(v.media);
      add('comment', v.id, v.from?.id, e.time, v.text ?? '', {
        echo: v.from?.id === e.id,
        alias: v.from?.username?.slice(0, 100) || null,
        postId: v.media.id,
        ...(ad ? { ad } : {}),
        commentId: v.id,
        permalink: postLink(v.media.permalink),
        replyTo: v.parent_id || null,
      });
    }
  }
  return result;
}
const eventKey = (e) => digest('event', e.channel, e.accountId, e.eventId);
module.exports = { events, eventKey, digest, mid, postLink };
