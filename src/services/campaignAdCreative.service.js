'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { Op } = require('sequelize');
const { loadWorkspaceInventory, selectedByWorkspace } = require('./campaignWorkspace.service');
const { accountAliases } = require('./campaignWorkspaceReport.service');

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const text = (value, max = 4000) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max) : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => { if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } } return Array.isArray(value) ? value : []; };
const strings = values => [...new Set(values.map(value => text(typeof value === 'object' ? value?.text : value)).filter(Boolean))].slice(0, 20);
const TTL = 86400;
let redis; const inflight = new Map(); const connecting = new WeakMap();

function creativeReference(input) {
  const fields = ['provider', 'account_id', 'campaign_id', 'ad_id', 'group_id'];
  if (!input || Object.keys(input).some(key => !fields.includes(key)) || !['google_ads', 'meta_ads'].includes(input.provider)
    || fields.slice(1).some(key => !id(input[key]))) fail('invalid_ad_creative', 400);
  return Object.fromEntries(fields.map(key => [key, input[key]]));
}

function publicUrl(value, media = false) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || net.isIP(hostname)
      || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test)$/.test(url.hostname)
      || [...url.searchParams.keys()].some(key => /^(access_token|authorization|password|secret)$/i.test(key))) return null;
    if (media && !/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

function normalizeCreative(provider, input, checkedAt) {
  input = object(input);
  const result = { provider, source: provider === 'google_ads' ? 'google_ads_cache' : 'meta_graph',
    checkedAt: checkedAt && Number.isFinite(+new Date(checkedAt)) ? new Date(checkedAt).toISOString() : null,
    headlines: [], bodies: [], descriptions: [], images: [], links: [], postUrl: null, video: false };
  if (provider === 'google_ads') {
    result.headlines = strings(list(input.headlines)); result.descriptions = strings(list(input.descriptions));
    result.links = [publicUrl(input.finalUrl)].filter(Boolean);
  } else {
    const spec = object(input.object_story_spec); const feed = object(input.asset_feed_spec);
    const blocks = [spec.link_data, spec.video_data, spec.template_data, spec.photo_data, spec.text_data].filter(Boolean);
    const children = blocks.flatMap(block => list(block.child_attachments));
    result.headlines = strings([input.title, ...blocks.map(block => block.name || block.title), ...children.map(child => child.name), ...list(feed.titles)]);
    result.bodies = strings([input.body, ...blocks.map(block => block.message), ...list(feed.bodies)]);
    result.descriptions = strings([...blocks.map(block => block.description), ...list(feed.descriptions)]);
    result.images = [...new Set([input.image_url, input.thumbnail_url, ...blocks.flatMap(block => [block.picture, block.image_url]),
      ...children.map(child => child.picture), ...list(feed.images).map(image => image.url)].map(value => publicUrl(value, true)).filter(Boolean))].slice(0, 10);
    result.links = [...new Set([input.link_url, ...blocks.flatMap(block => [block.link, block.call_to_action?.value?.link]),
      ...children.map(child => child.link), ...list(feed.link_urls).map(link => link.website_url)].map(value => publicUrl(value)).filter(Boolean))].slice(0, 10);
    const permalink = publicUrl(input.instagram_permalink_url);
    if (permalink && /(^|\.)instagram\.com$/.test(new URL(permalink).hostname)) result.postUrl = permalink;
    else if (typeof input.effective_object_story_id === 'string' && /^[1-9]\d{0,63}_[1-9]\d{0,63}$/.test(input.effective_object_story_id)) {
      const [page, post] = input.effective_object_story_id.split('_'); result.postUrl = `https://www.facebook.com/${page}/posts/${post}`;
    }
    result.video = !!input.video_id || !!spec.video_data || list(feed.videos).length > 0;
  }
  return { ...result, available: !!(result.headlines.length || result.bodies.length || result.descriptions.length || result.images.length || result.links.length || result.postUrl) };
}

async function inventoryContext({ models, scope, reference, loadInventory = loadWorkspaceInventory }) {
  const inventory = await loadInventory({ models, scope, accountReference: reference });
  const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
    { scope_type: 'clinic', scope_id: { [Op.in]: scope.clinicIds } },
    ...(inventory.groups.length ? [{ scope_type: 'group', scope_id: { [Op.in]: inventory.groups } }] : []),
  ] }, raw: true });
  const campaign = inventory.campaigns.find(row => row.provider === reference.provider && row.account_id === reference.account_id
    && row.campaign_id === reference.campaign_id && selectedByWorkspace(row, inventory, settings, scope));
  if (!campaign) fail('workspace_campaign_not_in_scope', 403);
  return { inventory, campaign };
}

async function metaCreativeContext({ models, scope, reference, inventory, campaign, now }) {
  const aliases = accountAliases('meta_ads', reference.account_id);
  const entity = await models.SocialAdsEntity.findOne({ where: { level: 'ad', ad_account_id: { [Op.in]: aliases },
    entity_id: reference.ad_id, parent_id: reference.group_id }, raw: true });
  const group = entity && await models.SocialAdsEntity.findOne({ where: { level: 'adset', ad_account_id: { [Op.in]: aliases },
    entity_id: reference.group_id, parent_id: reference.campaign_id }, raw: true });
  if (!entity || !group) fail('workspace_ad_not_in_scope', 404);
  const clinic = inventory.selectedClinics.find(row => Number(row.id_clinica) === campaign.clinicId);
  const groups = campaign.assigned ? [clinic?.grupoClinicaId].filter(Boolean) : inventory.authorizedGroups;
  const mappings = await models.ClinicMetaAsset.findAll({ where: { isActive: true, assetType: 'ad_account', metaAssetId: { [Op.in]: aliases },
    [Op.or]: [ { assignmentScope: 'clinic', clinicaId: campaign.assigned ? campaign.clinicId : { [Op.in]: scope.clinicIds } },
      ...(groups.length ? [{ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groups } }] : []) ] }, raw: true });
  const scopeKey = row => `${row.assignmentScope}:${row.assignmentScope === 'group' ? row.grupoClinicaId : row.clinicaId}`;
  const grants = mappings.length ? await models.MetaConnectionAssignment.findAll({ where: { status: 'active', scopeKey: { [Op.in]: mappings.map(scopeKey) } }, raw: true }) : [];
  const eligible = mappings.filter(row => grants.some(grant => grant.scopeKey === scopeKey(row) && Number(grant.metaConnectionId) === Number(row.metaConnectionId)));
  if (!eligible.length) fail('workspace_meta_permissions_required');
  const connections = [...new Set(eligible.map(row => Number(row.metaConnectionId)))];
  if (connections.length !== 1) fail('workspace_meta_connection_ambiguous');
  const connection = await models.MetaConnection.findByPk(connections[0], { raw: true });
  if (!connection?.accessToken || connection.expiresAt && (!Number.isFinite(+new Date(connection.expiresAt)) || +new Date(connection.expiresAt) <= +now)) fail('workspace_meta_permissions_required');
  return { connection, fingerprint: hash([reference, campaign.clinicId, scope.clinicIds.slice().sort((a, b) => a - b),
    eligible.map(row => [row.id, scopeKey(row), row.metaConnectionId]).sort(), grants.map(row => [row.id, row.status, row.connectedAt]).sort(),
    connection.id, hash(connection.accessToken), entity.updated_time || null]) };
}

function cacheClient() {
  if (!redis || redis.status === 'end') {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, enableOfflineQueue: false,
      maxRetriesPerRequest: 0, connectTimeout: 1500, commandTimeout: 1500, retryStrategy: () => null });
    redis.on('error', () => {});
  }
  return redis;
}

async function cachedCreative(key, load, { store = cacheClient(), now = new Date() } = {}) {
  if (inflight.has(key)) return inflight.get(key);
  const pending = (async () => {
    if (store.status === 'wait' && !connecting.has(store)) connecting.set(store, store.connect());
    const connection = connecting.get(store);
    if (connection) {
      try { await connection; } finally { if (connecting.get(store) === connection) connecting.delete(store); }
    }
    const stored = await store.get(key);
    if (stored) {
      try {
        const entry = JSON.parse(stored);
        if (entry.version === 1 && entry.expires > +now && entry.expires <= +now + TTL * 1000) return entry.value;
      } catch { /* Rebuild invalid cache entries without exposing their contents. */ }
    }
    const value = await load();
    const retryDelay = value.retryAt && Math.ceil((+new Date(value.retryAt) - +now) / 1000);
    const ttl = value.error ? (retryDelay > 0 ? Math.min(TTL, retryDelay) : 60) : TTL;
    await store.set(key, JSON.stringify({ version: 1, expires: +now + ttl * 1000, value }), 'EX', ttl);
    return value;
  })();
  inflight.set(key, pending);
  try { return await pending; } finally { inflight.delete(key); }
}

async function loadWorkspaceAdCreative({ models, scope, input, now = new Date(), loadInventory = loadWorkspaceInventory,
  read, cache = cachedCreative }) {
  const reference = creativeReference(input);
  const context = await inventoryContext({ models, scope, reference, loadInventory });
  if (reference.provider === 'google_ads') {
    const where = { customerId: { [Op.in]: accountAliases(reference.provider, reference.account_id) },
      campaignId: reference.campaign_id, adGroupId: reference.group_id, adId: reference.ad_id };
    const cached = await models.GoogleAdsAdInventory.findOne({ where,
      attributes: ['headlines', 'descriptions', 'finalUrl', 'observedAt'], order: [['observedAt', 'DESC'], ['id', 'DESC']], raw: true });
    const row = cached || await models.GoogleAdsAdInsightsDaily.findOne({ where: { customerId: { [Op.in]: accountAliases(reference.provider, reference.account_id) },
      campaignId: reference.campaign_id, adGroupId: reference.group_id, adId: reference.ad_id },
      attributes: ['headlines', 'descriptions', 'finalUrl', 'updated_at'], order: [['updated_at', 'DESC'], ['id', 'DESC']], raw: true });
    if (!row) fail('workspace_ad_not_in_scope', 404);
    return { success: true, reference, preview: normalizeCreative('google_ads', row, row.observedAt || row.updated_at), error: null };
  }
  const auth = await metaCreativeContext({ models, scope, reference, ...context, now });
  const key = `${process.env.RUNTIME_NAMESPACE || process.env.JOB_RUNTIME_NAMESPACE || 'dev'}:campaign-ad-creative:v1:${auth.fingerprint}`;
  let result;
  try {
    result = await cache(key, async () => {
      try {
        const response = await (read || require('../lib/metaClient').metaGet)(reference.ad_id, {
          accessToken: auth.connection.accessToken, params: { fields: 'id,account_id,campaign_id,adset_id,creative{id,title,body,image_url,thumbnail_url,video_id,link_url,instagram_permalink_url,effective_object_story_id,object_story_spec,asset_feed_spec}' },
          timeout: 10000, maxRetries: 0, source: 'campaign_workspace', operation: 'ad_creative_read' });
        const ad = response.data;
        if (ad?.id !== reference.ad_id || ad.account_id !== reference.account_id || ad.campaign_id !== reference.campaign_id || ad.adset_id !== reference.group_id) fail('workspace_ad_identity_mismatch');
        return { preview: normalizeCreative('meta_ads', ad.creative, now), error: null };
      } catch (error) {
        const code = Number(error.response?.data?.error?.code);
        if (['META_RATE_LIMIT_PAUSED', 'META_RATE_LIMITED'].includes(error.code)) {
          const until = error.pauseUntil && +new Date(error.pauseUntil);
          return { preview: null, error: 'workspace_creative_rate_limited',
            retryAt: Number.isFinite(until) && until > +now ? new Date(until).toISOString() : null };
        }
        return { preview: null, error: error.code === 'workspace_ad_identity_mismatch' ? error.code
          : [10, 190, 200].includes(code) ? 'workspace_meta_permissions_required' : 'workspace_creative_unavailable' };
      }
    }, { now });
  } catch { result = { preview: null, error: 'workspace_creative_unavailable' }; }
  // Revalidate scope and connection after the asynchronous provider/cache read.
  const current = await inventoryContext({ models, scope, reference, loadInventory });
  const next = await metaCreativeContext({ models, scope, reference, ...current, now: new Date() });
  if (next.fingerprint !== auth.fingerprint) fail('workspace_creative_scope_changed');
  return { success: true, reference, ...result };
}

module.exports = { creativeReference, publicUrl, normalizeCreative, cachedCreative, loadWorkspaceAdCreative, metaCreativeContext };
