'use strict';

const { createHmac } = require('node:crypto');
const { fail } = require('./errors');
const { pageFields, ensureField, subscriptionForm } = require('./meta-page-subscription');
const { usage } = require('./meta-marketing-ads-http');
const { graphId, GRAPH_VERSION } = require('./meta-marketing-contract');
const { schema } = require('./contracts');
const { operation: verify, verifyBody } = require('./meta-marketing-social-signature');
const status = 'meta.marketing.social.status.v1',
  send = 'meta.marketing.social.send.v1';
const outcome = 'meta.marketing.social.outcome.v1';
const receive = 'meta.marketing.social.receive.v1';
const History = require('./meta-marketing-social-history');
const history = History.operation;
const subscribe = 'meta.marketing.social.subscribe.v1';
const ops = [status, receive, send, verify, outcome, history, subscribe];
const id = { type: 'string', pattern: '^[1-9][0-9]{0,29}$' };
const scope = {
  accountId: id,
  clinicId: { type: 'integer', minimum: 1 },
  channel: { enum: ['instagram', 'messenger'] },
  kind: { enum: ['dm', 'comment'] },
};
const checks = {
  [verify]: schema({
    rawBase64: { type: 'string', maxLength: 87384, minLength: 4 },
    signature: { type: 'string', pattern: '^sha256=[a-f0-9]{64}$' },
  }),
  [status]: schema(scope),
  [subscribe]: schema({
    clinicId: scope.clinicId, channel: { const: 'messenger' }, kind: { const: 'dm' }, accountId: id,
    enrollmentId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }, versionId: { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
  }),
  [send]: schema({
    ...scope,
    recipient: id,
    text: { type: 'string', minLength: 1, maxLength: 1000 },
    attemptId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
  }),
};
const historyFields = {
  ...scope,
  start: { type: 'integer', minimum: 1 },
  end: { type: 'integer', minimum: 1 },
  cursor: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[A-Za-z0-9_-]{40,4096}$' }] },
};
const checkAccountHistory = schema(historyFields);
const checkParticipantHistory = schema({
  ...historyFields,
  kind: { const: 'dm' },
  channel: { const: 'instagram' },
  participantId: id,
});
checks[history] = payload =>
  payload?.participantId === undefined ? checkAccountHistory(payload) : checkParticipantHistory(payload);
const receiptFields = { ...scope, senderId: id,
  postId: { anyOf: [id, { type: 'null' }] }, commentId: { anyOf: [id, { type: 'null' }] } };
const checkLiveReceipt = schema(receiptFields);
const checkHistoryReceipt = schema({ ...receiptFields, history: { const: true } });
checks[receive] = p => p?.history === true ? checkHistoryReceipt(p) : checkLiveReceipt(p);
checks[outcome] = checks[send];
function postPreviewUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && !url.searchParams.has('access_token') && /\.(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) return url.href;
  } catch {}
  return null;
}

const { config } = require('./meta-marketing-social-consent');
function authorize(rows, asset, request, clinicIds) {
  const p = request.payload;
  if (
    !rows ||
    asset.kind !== 'facebook_page' ||
    !rows.some(
      (r) =>
        r.pageId === asset.id &&
        clinicIds.includes(r.clinicId) &&
        (request.operation === verify ||
          (r.channel === p.channel && r.accountId === p.accountId && r.clinicId === p.clinicId)),
    )
  )
    fail('scope_denied');
  if (request.operation === send && p.channel !== 'instagram') fail('operation_denied');
}
const permissions = (channel, kind, operation) =>
  channel === 'messenger'
    ? ['pages_manage_metadata', 'pages_read_engagement', 'pages_messaging']
    : [
        'pages_manage_metadata',
        'instagram_basic',
        ...(kind === 'dm' || ![receive, history].includes(operation) ? ['instagram_manage_messages'] : []),
        ...(kind === 'dm' && operation === history ? ['pages_messaging'] : []),
        ...(kind === 'comment' ? ['instagram_manage_comments', 'pages_read_engagement'] : []),
      ];

async function execute({
  operation,
  payload: p,
  context,
  token,
  appSecret,
  metadata,
  asset,
  signal,
  authorize: check,
  transport = fetch,
  subscriptionPacer,
}) {
  const appToken = metadata.appId + '|' + appSecret.toString();
  async function graph(path, bearer, query = {}, body) {
    if (operation === subscribe) {
      if (!subscriptionPacer) fail('connection_blocked');
      return subscriptionPacer.run('meta-ads-app:' + metadata.appId, { signal, deadline },
        () => graphRequest(path, bearer, query, body));
    }
    return graphRequest(path, bearer, query, body);
  }
  const deadline = Date.now() + 24000;
  function historyFailure(path, reason, status, code) {
    if (operation !== history) return;
    const edge = path.split('/').at(-1);
    if (['accounts', 'debug_token', 'conversations', 'messages', 'media', 'comments', 'replies'].includes(edge))
      process.stderr.write(JSON.stringify({ event: 'meta_social_history_failed', channel: p.channel, kind: p.kind, edge, reason, status, code }) + '\n');
  }
  async function graphRequest(path, bearer, query = {}, body) {
    check();
    const url = new URL(
      'https://graph.facebook.com/' + (metadata.graphVersion || GRAPH_VERSION) + '/' + path,
    );
    const pageForm = operation === subscribe && body;
    const proof = createHmac('sha256', appSecret).update(bearer).digest('hex');
    url.search = new URLSearchParams({
      ...query,
      ...(pageForm ? {} : { appsecret_proof: proof }),
    }).toString();
    let response, raw;
    try {
      response = await transport(url, {
        redirect: 'error',
        signal,
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: 'Bearer ' + bearer,
          ...(body ? { 'content-type': pageForm ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
        },
        ...(body ? { body: pageForm ? subscriptionForm(body, proof) : JSON.stringify(body) } : {}),
      });
      raw = await response.json();
    } catch (error) {
      if (signal?.aborted) {
        historyFailure(path, 'provider_timeout');
        fail('provider_timeout');
      }
      throw error;
    }
    if (operation === subscribe && response.headers)
      subscriptionPacer.observe('meta-ads-app:' + metadata.appId, usage(Object.fromEntries(response.headers)));
    if ([subscribe, history].includes(operation) && (response.status === 429 || [4, 17, 32, 613, 80006].includes(raw.error?.code))) {
      historyFailure(path, 'rate_limited', response.status, raw.error?.code);
      fail('rate_limited');
    }
    if (raw.error || !response.ok) {
      historyFailure(path, 'graph_error', response.status, Number.isInteger(raw.error?.code) ? raw.error.code : undefined);
      if (
        p.channel === 'instagram' && response.status >= 400 && response.status < 500 && raw.error?.code === 200 &&
        /^(?:\(#200\)\s*)?the account owner has disabled access to instagram direct messages\.?$/i.test(raw.error.message) &&
        ((operation === history && p.kind === 'dm' && /\/(?:conversations|messages)$/.test(path)) ||
          (operation === send && body && path === asset.id + '/messages'))
      ) {
        return { rejected: 'instagram_inbox_access_disabled' };
      }
      if (
        body &&
        response.status >= 400 &&
        response.status < 500 &&
        [100, 551].includes(raw.error?.code)
      )
        return { rejected: raw.error.code === 551 ? 'recipient_unavailable' : 'provider_rejected' };
      if ([10, 190, 200].includes(raw.error?.code)) fail('provider_unauthorized');
      fail('provider_failed');
    }
    check();
    return raw;
  }
  const expected = permissions(p.channel, p.kind, operation);
  const missingGrant = ['pages_show_list', ...expected].find((s) => !metadata.scopes.includes(s));
  if (missingGrant) return { available: false, reason: 'permission:' + missingGrant };
  const outsideTarget = ['pages_show_list', ...expected].find((s) =>
    metadata.granularScopes?.some(
      (g) => g.scope === s && !g.targetIds.some((id) => id === asset.id || id === p.accountId),
    ),
  );
  if (outsideTarget) return { available: false, reason: 'permission:' + outsideTarget };
  const fields =
    p.channel === 'instagram'
      ? 'id,name,access_token,tasks,instagram_business_account{id,username}'
      : 'id,name,access_token,tasks';
  let page, after;
  for (let batch = 0; batch < 10; batch++) {
    const pages = await graph('me/accounts', token.toString(), {
      fields,
      limit: '100',
      ...(after ? { after } : {}),
    });
    page = pages.data?.find((row) => row.id === asset.id);
    if (page || !pages.paging?.next) break;
    const cursor = pages.paging.cursors?.after;
    if (typeof cursor !== 'string' || !cursor || cursor === after || cursor.length > 4096)
      fail('provider_failed');
    after = cursor;
  }
  if (
    page?.id !== asset.id ||
    typeof page.access_token !== 'string' ||
    !page.access_token ||
    (p.channel === 'instagram' && page.instagram_business_account?.id !== p.accountId)
  )
    fail('scope_denied');
  const debug = (await graph('debug_token', appToken, { input_token: page.access_token })).data;
  if (
    !debug?.is_valid ||
    debug.type !== 'PAGE' ||
    debug.app_id !== metadata.appId ||
    debug.profile_id !== asset.id ||
    [debug.expires_at, debug.data_access_expires_at].some(
      (t) => !Number.isSafeInteger(t) || t < 0 || (t && t * 1000 <= Date.now()),
    )
  )
    fail('provider_unauthorized');
  const pagePermissions = operation === subscribe ? ['pages_show_list', ...expected] : expected;
  const missing = pagePermissions.filter(
    (s) =>
      !debug.scopes?.includes(s) ||
      (debug.granular_scopes || []).some(
        (g) =>
          g.scope === s &&
          g.target_ids &&
          !g.target_ids.some((id) => id === asset.id || id === p.accountId),
      ),
  );
  const accountName =
    p.channel === 'instagram'
      ? '@' + (page.instagram_business_account.username || p.accountId)
      : page.name;
  const blocked = (reason) => ({ available: false, reason, accountName });
  if (missing.length) return blocked('permission:' + missing[0]);
  const allowedTasks =
    [receive, history].includes(operation) && p.kind === 'comment'
      ? ['MODERATE', 'MANAGE', 'MESSAGING']
      : ['MESSAGING', 'MANAGE'];
  if (!allowedTasks.some((task) => page.tasks?.includes(task))) return blocked('page_messaging_task');
  if (operation === subscribe) {
    if (!page.tasks.some(task => ['CREATE_CONTENT', 'MANAGE', 'MODERATE'].includes(task))) return blocked('page_subscription_task');
    const app = await graph(metadata.appId + '/subscriptions', appToken, { fields: 'object,active,fields' });
    if (!app.data?.some(row => row.object === 'page' && row.active === true && row.fields?.some(f => f.name === 'messages')))
      return blocked('subscription:messages');
    const edge = asset.id + '/subscribed_apps';
    const read = async () => ({ subscription: pageFields(await graph(edge, page.access_token, {
      fields: 'id,subscribed_fields', limit: '100',
    }), metadata.appId) });
    await ensureField({
      appId: metadata.appId, pageId: asset.id, field: 'messages', read, authorize: check,
      write: fields => graph(edge, page.access_token, {}, fields),
    });
    return { available: true };
  }
  if (operation === history) return History.read({ payload: p, asset, context, appSecret, graph, pageToken: page.access_token });
  if (!(operation === receive && p.history === true)) {
    const subs = await graph(asset.id + '/subscribed_apps', page.access_token, {
      fields: 'id,subscribed_fields',
      limit: '100',
    });
    const installed = subs.data?.find((a) => a.id === metadata.appId);
    if (!installed || (p.channel === 'messenger' && !installed.subscribed_fields?.includes('messages')))
      return blocked('subscription:messages');
    const object = p.channel === 'messenger' ? 'page' : 'instagram',
      field = p.kind === 'comment' ? 'comments' : 'messages';
    const appSubs = await graph(metadata.appId + '/subscriptions', appToken, {
      fields: 'object,active,fields',
    });
    if (
      !appSubs.data?.some(
        (s) => s.object === object && s.active !== false && s.fields?.some((f) => f.name === field),
      )
    )
      return blocked('subscription:' + field);
  }
  if (operation === receive) {
    let alias = null,
      permalink = null,
      commentAt = null,
      post = null;
    if (p.kind === 'comment') {
      if (!p.postId || !p.commentId || p.channel !== 'instagram') fail('scope_denied');
      const media = await graph(p.postId, page.access_token, { fields: 'id,owner,permalink,caption,media_type,media_url,thumbnail_url' });
      if (media.id !== p.postId || media.owner?.id !== p.accountId)
        return blocked('post_owner_unverified');
      const comment = await graph(p.commentId, page.access_token, { fields: 'id,media,from,timestamp' });
      const at = Date.parse(comment.timestamp);
      if (
        comment.id !== p.commentId ||
        comment.media?.id !== p.postId ||
        comment.from?.id !== p.senderId ||
        !Number.isFinite(at) ||
        at > Date.now() + 300000
      )
        return blocked('comment_unavailable');
      commentAt = new Date(at).toISOString();
      permalink = media.permalink || null;
      const mediaType = ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'].includes(media.media_type) ? media.media_type : null;
      post = {
        mediaType,
        caption: typeof media.caption === 'string' ? media.caption.slice(0, 4400) : null,
        previewUrl: postPreviewUrl(mediaType === 'VIDEO' ? media.thumbnail_url : mediaType && media.media_url),
      };
    } else {
      try {
        const person = await graph(p.senderId, page.access_token, {
          fields: p.channel === 'instagram' ? 'id,username' : 'id,first_name,last_name',
        });
        if (person.id === p.senderId)
          alias =
            p.channel === 'instagram'
              ? person.username
              : [person.first_name, person.last_name].filter(Boolean).join(' ');
      } catch (error) {
        if (!['provider_failed', 'provider_unauthorized'].includes(error.code)) throw error;
      }
    }
    return {
      available: true,
      accountName,
      alias: typeof alias === 'string' ? alias.slice(0, 100) : null,
      permalink,
      commentAt,
      ...(post ? { post } : {}),
    };
  }
  if (operation === status) return { available: true, accountName };
  const recipient = p.kind === 'comment' ? { comment_id: p.recipient } : { id: p.recipient };
  let sent;
  try {
    sent = await graph(
      asset.id + '/messages',
      page.access_token,
      {},
      { recipient, message: { text: p.text, metadata: 'cc-social:' + p.attemptId } },
    );
  } catch (error) {
    if (error.code === 'provider_unauthorized') return blocked(error.code);
    throw error;
  }
  if (sent.rejected) return blocked(sent.rejected);
  if (
    typeof sent.message_id !== 'string' ||
    !sent.message_id ||
    sent.message_id.length > 512 ||
    !graphId(sent.recipient_id) ||
    (p.kind === 'dm' && sent.recipient_id !== p.recipient)
  )
    fail('outcome_unknown');
  return { available: true, messageId: sent.message_id, recipientId: sent.recipient_id };
}
module.exports = {
  subscribe,
  status,
  history,
  receive,
  send,
  verify,
  outcome,
  ops,
  checks,
  config,
  authorize,
  verifyBody,
  execute,
  permissions,
};
