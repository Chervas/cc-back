'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { loadWorkspaceInventory, selectedByWorkspace } = require('./campaignWorkspace.service');
const { accountId, accountAliases } = require('./campaignWorkspaceReport.service');
const { loadWorkspaceAdCreative, publicUrl } = require('./campaignAdCreative.service');
const { createAdSharingAuthority } = require('./adSharingAuthority.service');
const { attachLeadAdvertisingIdentities, canonicalLeadAdvertisingIdentity, resolveNativeMetaLeadIdentity } = require('./leadAdvertisingIdentity.service');
const { PURPOSES, FAMILIES } = require('../lib/ad-sharing-templates');
const { validSharing } = require('../lib/social-ad-creative-snapshot');

const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
const numericId = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
const plain = value => value?.get ? value.get({ plain: true }) : value;
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 4000) : '';
const active = row => String(row.effective_status || row.status || '').toUpperCase() === 'ACTIVE';
const activeWhere = { [Op.or]: [{ effective_status: 'ACTIVE' }, { effective_status: null, status: 'ACTIVE' }, { effective_status: '', status: 'ACTIVE' }] };
const PAGE_SIZE = 20;
const fields = ['ad_account_id', 'entity_id', 'parent_id', 'name', 'effective_status', 'status', 'updated_at', 'updated_time', 'creative_payload'];

// Each authorization phase shares account/grant reads across the page. The
// second phase uses fresh models/rows, so memoization cannot hide revocation.
function authorizationModels(models, ads, groups, settings) {
  const memo = fn => {
    const pending = new Map();
    return (...args) => {
      const encode = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(encode)
        : Object.fromEntries(Reflect.ownKeys(value).map(key => [String(key), encode(value[key])])) : value;
      const key = JSON.stringify(encode(args));
      if (!pending.has(key)) pending.set(key, fn(...args));
      return pending.get(key);
    };
  };
  return { ...models,
    SocialAdsEntity: { findOne: async ({ where }) => (where.level === 'ad' ? ads : groups).find(row =>
      row.entity_id === where.entity_id && row.parent_id === where.parent_id
      && where.ad_account_id[Op.in].includes(row.ad_account_id)) || null },
    CampaignWorkspaceSetting: { findAll: async () => settings },
    ClinicMetaAsset: { findAll: memo(options => models.ClinicMetaAsset.findAll(options)) },
    MetaConnectionAssignment: { findAll: memo(options => models.MetaConnectionAssignment.findAll(options)) },
    MetaConnection: { findByPk: memo((...args) => models.MetaConnection.findByPk(...args)) },
  };
}

function sharingInput(input, scope) {
  if (scope.clinicIds?.length !== 1 || !Number.isSafeInteger(Number(scope.clinicIds[0])) || Number(scope.clinicIds[0]) <= 0) fail('single_clinic_scope_required', 400);
  if (!input || Object.keys(input).some(key => !['purpose', 'lead_id', 'page', 'search'].includes(key)) || !PURPOSES.includes(input.purpose)) fail('invalid_ad_sharing_request', 400);
  const page = input.page == null ? 1 : Number(input.page);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || input.page != null && (!['string', 'number'].includes(typeof input.page) || !/^[1-9]\d*$/.test(String(input.page)))) fail('invalid_ad_sharing_page', 400);
  if (input.search != null && (typeof input.search !== 'string' || input.search.length > 120)) fail('invalid_ad_sharing_search', 400);
  if (input.purpose === 'lead_ad' && (!numericId(input.lead_id) || !Number.isSafeInteger(Number(input.lead_id)))) fail('ad_sharing_lead_required', 400);
  if (input.purpose === 'patient_promotion' && input.lead_id != null) fail('invalid_ad_sharing_request', 400);
  return { purpose: input.purpose, page, search: text(input.search), leadId: input.lead_id, clinicId: Number(scope.clinicIds[0]) };
}

function mediaUrl(value, now) {
  const result = publicUrl(value, true);
  if (!result || result.length > 2048) return null;
  const url = new URL(result);
  for (const key of ['oe', 'expires', 'exp']) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    const seconds = key === 'oe' && /^[a-f0-9]+$/i.test(raw) ? parseInt(raw, 16) : /^\d+$/.test(raw) ? Number(raw) : null;
    if (seconds != null && seconds * 1000 <= +now) return null;
  }
  return result;
}

function unavailable(reason, preview = {}) {
  return { available: false, reason, source: null, kind: null, imageUrl: null, videoUrl: null,
    thumbnailUrl: null, body: '', headline: '', link: null, preserveOriginal: true, ...preview };
}

function creativeFromPost(post, now) {
  const kind = String(post.media_type || post.post_type || '').toUpperCase();
  const postKind = String(post.post_type || '').toUpperCase();
  const preview = { source: 'social_posts', body: text(post.content), headline: text(post.title), link: publicUrl(post.permalink_url) };
  if (/CAROUSEL|ALBUM/.test(kind + postKind)) return unavailable('carousel_not_supported', preview);
  const original = mediaUrl(post.original_media_url, now);
  const thumbnail = mediaUrl(post.media_url, now);
  const url = original || thumbnail;
  if (/VIDEO|REEL/.test(kind + postKind)) {
    // The synchronizer can store a video thumbnail in media_url. Only a direct
    // original video URL is a VIDEO candidate, never a still image or permalink.
    const video = original && !/\.(jpe?g|png|webp)$/i.test(new URL(original).pathname) ? original
      : thumbnail && /\.mp4$/i.test(new URL(thumbnail).pathname) ? thumbnail : null;
    if (!video) return unavailable('video_original_unavailable', { ...preview, kind: 'VIDEO', thumbnailUrl: thumbnail });
    return { ...unavailable(null, preview), available: true, kind: 'VIDEO', videoUrl: video, thumbnailUrl: thumbnail === video ? null : thumbnail,
      mediaParameter: { type: 'video', video: { link: video } } };
  }
  if (!/^(PHOTO|IMAGE|PICTURE)$/.test(kind) || !url || /\.(mp4|mov)$/i.test(new URL(url).pathname)) return unavailable('original_media_unavailable', preview);
  return { ...unavailable(null, preview), available: true, kind: 'IMAGE', imageUrl: url,
    mediaParameter: { type: 'image', image: { link: url } } };
}

function creativeFromCache(preview, now) {
  if (!preview || typeof preview !== 'object') return unavailable('creative_not_synchronized');
  const common = { source: 'creative_cache', body: text(preview.bodies?.[0]), headline: text(preview.headlines?.[0]),
    link: publicUrl(preview.postUrl || preview.links?.[0]) };
  const images = [...new Set((Array.isArray(preview.images) ? preview.images : []).map(value => mediaUrl(value, now)).filter(Boolean))];
  if (preview.video) return unavailable('video_original_unavailable', { ...common, kind: 'VIDEO', thumbnailUrl: images[0] || null });
  if (images.length > 1 || preview.bodies?.length > 1 || preview.headlines?.length > 1) return unavailable('creative_variants_require_selection', common);
  if (images.length !== 1) return unavailable('original_media_unavailable', common);
  return { ...unavailable(null, common), available: true, kind: 'IMAGE', imageUrl: images[0],
    mediaParameter: { type: 'image', image: { link: images[0] } } };
}

function snapshotValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return false; }
}

function snapshotDigest(value) {
  const parsed = snapshotValue(value);
  const canonical = item => item && typeof item === 'object' ? Array.isArray(item) ? item.map(canonical)
    : Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(parsed ? {
    version: parsed.version, reference: parsed.reference, creativeId: parsed.creativeId ?? null, creative: parsed.creative,
  } : parsed ?? null))).digest('hex');
}

function creativeFromSnapshot(value, reference, now, selectedVariantId = null) {
  if (value == null) return null;
  const payload = snapshotValue(value);
  if (!payload || ![1, 2].includes(payload.version) || payload.version !== payload.creative?.version || !validSharing(payload.creative)
    || !Number.isFinite(+new Date(payload.observedAt)) || +new Date(payload.observedAt) > +now + 300000
    || !payload.reference || Object.keys(reference).some(key => payload.reference[key] !== reference[key])) {
    return unavailable('creative_snapshot_invalid', { source: 'ad_sync' });
  }
  const sharing = payload.creative;
  const preview = { source: 'ad_sync', kind: sharing.kind, body: text(sharing.body), headline: text(sharing.title),
    thumbnailUrl: mediaUrl(sharing.thumbnail_url, now) };
  if (sharing.source_issue === 'carousel_not_supported') return unavailable(sharing.source_issue, preview);
  if (payload.version === 2 && sharing.source_issue && sharing.source_issue !== 'creative_variants_require_selection') {
    return unavailable(sharing.source_issue, preview);
  }
  if (payload.version === 2 && sharing.alternatives.length) {
    const copies = new Map(sharing.copies.map(copy => [copy.copy_id, copy]));
    const sourceDigest = snapshotDigest(value);
    const alternatives = sharing.alternatives.map(option => {
      const copy = copies.get(option.copy_id);
      const common = { source: 'ad_sync', variant_id: option.variant_id,
        copy_id: option.copy_id, provenance: { ...option.provenance }, snapshot_sha256: sourceDigest };
      if (option.source_issue) return unavailable(option.source_issue, { ...common, kind: option.kind,
        body: text(copy.body), headline: text(copy.title), thumbnailUrl: mediaUrl(option.thumbnail_url, now) });
      return { ...creativeFromPost({ media_type: option.kind, post_type: option.kind,
        content: copy.body, title: copy.title,
        media_url: option.kind === 'VIDEO' ? option.thumbnail_url : option.image_url,
        original_media_url: option.kind === 'VIDEO' ? option.original_media_url : null }, now), ...common };
    });
    if (selectedVariantId !== null) {
      const selected = alternatives.find(option => option.variant_id === selectedVariantId);
      if (!selected) fail('ad_sharing_variant_changed');
      return { ...selected, requiresSelection: false };
    }
    return unavailable('creative_variants_require_selection', { source: 'ad_sync', requiresSelection: true, alternatives });
  }
  if (selectedVariantId !== null) fail('ad_sharing_variant_changed');
  if (sharing.has_variants) return unavailable('creative_variants_require_selection', preview);
  if (sharing.source_issue) return unavailable(sharing.source_issue, preview);
  if (!sharing.kind) return unavailable('original_media_unavailable', preview);
  return { ...creativeFromPost({ media_type: sharing.kind, post_type: sharing.kind, content: sharing.body, title: sharing.title,
    media_url: sharing.kind === 'VIDEO' ? sharing.thumbnail_url : sharing.image_url,
    original_media_url: sharing.kind === 'VIDEO' ? sharing.original_media_url : null }, now), source: 'ad_sync' };
}

function finalizeCreative(creative, reference) {
  if (creative.alternatives) creative.alternatives = creative.alternatives.map(option => finalizeCreative(option, reference));
  creative.shareText = creative.body || creative.headline || 'Puedes consultar los detalles en el anuncio adjunto.';
  if (creative.shareText.length > 1024) {
    creative.reason = 'ad_copy_too_long_for_template';
    creative.available = false;
  }
  const identity = [reference, creative.source, creative.kind, creative.imageUrl, creative.videoUrl, creative.shareText];
  if (creative.variant_id) identity.push(creative.variant_id, creative.snapshot_sha256);
  creative.fingerprint = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return creative;
}

async function leadReference({ models, clinicId, leadId, attachIdentities = attachLeadAdvertisingIdentities }) {
  const lead = await models.LeadIntake.findOne({ where: { id: Number(leadId), clinica_id: clinicId, archived_at: null },
    attributes: ['id', 'clinica_id', 'source', 'external_source', 'external_id', 'google_ads_customer_id', 'google_ads_campaign_id'], raw: true });
  if (!lead) fail('ad_sharing_lead_not_found', 404);
  let identity;
  if (lead.source === 'meta_ads' && lead.external_source === 'meta_leadgen') {
    identity = await resolveNativeMetaLeadIdentity({ models, lead });
  } else {
    await attachIdentities({ models, leads: [lead] });
    identity = canonicalLeadAdvertisingIdentity(lead);
  }
  if (lead.advertising_identity_conflict || identity?.provider !== 'meta_ads' || ![identity.account_id, identity.campaign_id, identity.ad_id].every(numericId)) return null;
  return identity;
}

async function loadAdSharing({ models, scope, input, now = new Date(), loadInventory = loadWorkspaceInventory,
  loadCreative = loadWorkspaceAdCreative, authorizeCreative = null, attachIdentities = attachLeadAdvertisingIdentities,
  selectedAdId = null, selectedVariantId = null }) {
  const request = sharingInput(input, scope);
  const authorize = authorizeCreative || createAdSharingAuthority({ models });
  if (selectedAdId !== null && !numericId(selectedAdId)) fail('invalid_ad_sharing_request', 400);
  if (selectedVariantId !== null && (typeof selectedVariantId !== 'string' || !/^[a-f0-9]{64}$/.test(selectedVariantId)
    || selectedAdId === null)) fail('invalid_ad_sharing_request', 400);
  const reference = request.purpose === 'lead_ad' ? await leadReference({ models, ...request, attachIdentities }) : null;
  const result = { success: true, purpose: request.purpose, clinicId: request.clinicId,
    templateFamily: FAMILIES[request.purpose].IMAGE, templateFamilies: FAMILIES[request.purpose],
    requiresApprovedTemplate: true, maxItems: 1, items: [], selected: null,
    pagination: { page: request.page, pageSize: PAGE_SIZE, total: 0 }, unavailableReason: null };
  if (request.purpose === 'lead_ad' && !reference) return { ...result, unavailableReason: 'lead_ad_attribution_unavailable' };
  const inventory = await loadInventory({ models, scope, ...(reference ? { accountReference: reference } : {}) });
  const settings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
    { scope_type: 'clinic', scope_id: request.clinicId },
    ...(inventory.groups.length ? [{ scope_type: 'group', scope_id: { [Op.in]: inventory.groups } }] : []),
  ] }, raw: true });
  const campaigns = inventory.campaigns.filter(c => c.provider === 'meta_ads' && c.assigned && Number(c.clinicId) === request.clinicId
    && selectedByWorkspace(c, inventory, settings, scope)
    && (request.purpose === 'lead_ad' ? c.account_id === reference.account_id && c.campaign_id === reference.campaign_id : active(c)));
  if (!campaigns.length) return { ...result, unavailableReason: 'no_authorized_ads' };
  const groups = await models.SocialAdsEntity.findAll({ where: { level: 'adset', [Op.or]: campaigns.map(c => ({
    ad_account_id: { [Op.in]: accountAliases('meta_ads', c.account_id) }, parent_id: c.campaign_id,
  })), ...(request.purpose === 'patient_promotion' ? { [Op.and]: [activeWhere] } : {}) }, attributes: fields, raw: true });
  if (!groups.length) return { ...result, unavailableReason: 'no_authorized_ads' };
  const groupMap = new Map(groups.map(g => [`${accountId(g.ad_account_id)}:${g.entity_id}`, g]));
  const search = request.search.replace(/[\\%_]/g, '\\$&');
  const ads = await models.SocialAdsEntity.findAndCountAll({ where: { level: 'ad', [Op.or]: groups.map(g => ({
    ad_account_id: { [Op.in]: accountAliases('meta_ads', g.ad_account_id) }, parent_id: g.entity_id,
  })), [Op.and]: [...(request.purpose === 'patient_promotion' ? [activeWhere] : []),
    ...(reference ? [{ entity_id: reference.ad_id }] : []), ...(selectedAdId ? [{ entity_id: selectedAdId }] : []),
    ...(search ? [{ name: { [Op.like]: `%${search}%` } }] : [])] },
  attributes: fields, raw: true, limit: request.purpose === 'lead_ad' || selectedAdId ? 1 : PAGE_SIZE,
  offset: request.purpose === 'lead_ad' || selectedAdId ? 0 : (request.page - 1) * PAGE_SIZE, order: [['name', 'ASC'], ['entity_id', 'ASC']] });
  result.pagination.total = Number(ads.count);
  const entries = ads.rows.map(ad => {
    const group = groupMap.get(`${accountId(ad.ad_account_id)}:${ad.parent_id}`);
    const campaign = group && campaigns.find(c => c.account_id === accountId(ad.ad_account_id) && c.campaign_id === group.parent_id);
    if (!campaign) fail('ad_sharing_inventory_changed');
    return { ad, campaign, reference: { provider: 'meta_ads', account_id: accountId(ad.ad_account_id), campaign_id: campaign.campaign_id,
      group_id: ad.parent_id, ad_id: ad.entity_id } };
  });
  const beforeModels = authorizationModels(models, entries.map(e => e.ad), groups, settings);
  const beforeAuth = new Map();
  await Promise.all(entries.map(async entry => {
    const auth = await authorize({ models: beforeModels, scope, reference: entry.reference, inventory, campaign: entry.campaign, now });
    if (request.purpose === 'patient_promotion' && (!active(entry.ad) || !active(groupMap.get(`${entry.reference.account_id}:${entry.reference.group_id}`)))) fail('ad_sharing_inventory_changed');
    beforeAuth.set(entry.reference.ad_id, auth);
  }));
  // Batched, exact ad-to-post links. A post belonging to another clinic is
  // never a fallback, even if an account, caption or media happens to match.
  const promotions = entries.length ? await models.PostPromotions.findAll({ where: { [Op.or]: entries.map(e => ({
    ad_account_id: { [Op.in]: accountAliases('meta_ads', e.reference.account_id) }, campaign_id: e.reference.campaign_id,
    adset_id: e.reference.group_id, ad_id: e.reference.ad_id,
  })) }, attributes: ['id', 'ad_account_id', 'campaign_id', 'adset_id', 'ad_id', 'post_id'],
  include: [{ model: models.SocialPosts, as: 'post', required: true, where: { clinica_id: request.clinicId },
    attributes: ['id', 'clinica_id', 'post_type', 'media_type', 'title', 'content', 'media_url', 'original_media_url', 'permalink_url'] }] }) : [];
  result.items = await Promise.all(entries.map(async entry => {
    const snapshot = creativeFromSnapshot(entry.ad.creative_payload, entry.reference, now, selectedVariantId);
    if (!snapshot && selectedVariantId !== null) fail('ad_sharing_variant_changed');
    const posts = promotions.map(plain).filter(p => accountId(p.ad_account_id) === entry.reference.account_id
      && p.campaign_id === entry.reference.campaign_id && p.adset_id === entry.reference.group_id && p.ad_id === entry.reference.ad_id)
      .map(p => plain(p.post)).filter(p => p && Number(p.clinica_id) === request.clinicId);
    const uniquePosts = [...new Map(posts.map(p => [JSON.stringify([
      String(p.media_type || p.post_type).toUpperCase(), String(p.post_type || '').toUpperCase(),
      p.original_media_url || p.media_url, text(p.content), text(p.title),
    ]), p])).values()];
    let creative = snapshot;
    if (!snapshot && uniquePosts.length > 1) creative = unavailable('creative_variants_require_selection');
    else if (!snapshot && uniquePosts.length === 1) creative = creativeFromPost(uniquePosts[0], now);
    if (!snapshot && (!creative || creative.reason === 'original_media_unavailable')) {
      if (beforeAuth.get(entry.reference.ad_id).authority === 'broker') {
        // The historical Redis key is tied to a legacy token fingerprint. A
        // broker account without a synchronized original waits for normal sync.
        creative = creative || unavailable('creative_not_synchronized');
      } else {
        const cached = await loadCreative({ models: beforeModels, scope, input: entry.reference, now,
          loadInventory: async () => inventory, cacheOnly: true });
        creative = creativeFromCache(cached.preview, now);
      }
    }
    finalizeCreative(creative, entry.reference);
    return { reference: entry.reference, title: text(entry.ad.name), campaignName: text(entry.campaign.name),
      status: String(entry.ad.effective_status || entry.ad.status || 'UNKNOWN'), creative,
      templateFamily: FAMILIES[request.purpose][creative.kind || 'IMAGE'],
      selection: { allowed: creative.available && creative.shareText.length <= 1024, maxItems: 1, requiresApprovedTemplate: true } };
  }));
  if (entries.length) {
    const current = await loadInventory({ models, scope });
    const currentSettings = await models.CampaignWorkspaceSetting.findAll({ where: { [Op.or]: [
      { scope_type: 'clinic', scope_id: request.clinicId },
      ...(current.groups.length ? [{ scope_type: 'group', scope_id: { [Op.in]: current.groups } }] : []),
    ] }, raw: true });
    const currentEntities = await models.SocialAdsEntity.findAll({ where: { [Op.or]: entries.flatMap(entry => [
      { level: 'ad', ad_account_id: { [Op.in]: accountAliases('meta_ads', entry.reference.account_id) }, entity_id: entry.reference.ad_id },
      { level: 'adset', ad_account_id: { [Op.in]: accountAliases('meta_ads', entry.reference.account_id) }, entity_id: entry.reference.group_id },
    ]) }, attributes: ['level', ...fields], raw: true });
    const afterModels = authorizationModels(models, currentEntities.filter(e => e.level === 'ad'), currentEntities.filter(e => e.level === 'adset'), currentSettings);
    await Promise.all(entries.map(async entry => {
      const campaign = current.campaigns.find(c => c.provider === 'meta_ads' && c.account_id === entry.reference.account_id
        && c.campaign_id === entry.reference.campaign_id && c.assigned && Number(c.clinicId) === request.clinicId
        && selectedByWorkspace(c, current, currentSettings, scope));
      if (!campaign || request.purpose === 'patient_promotion' && !active(campaign)) fail('ad_sharing_inventory_changed');
      const currentAd = currentEntities.find(row => row.level === 'ad' && row.entity_id === entry.reference.ad_id
        && row.parent_id === entry.reference.group_id && accountId(row.ad_account_id) === entry.reference.account_id);
      const currentGroup = currentEntities.find(row => row.level === 'adset' && row.entity_id === entry.reference.group_id
        && row.parent_id === entry.reference.campaign_id && accountId(row.ad_account_id) === entry.reference.account_id);
      if (!currentAd || !currentGroup || snapshotDigest(currentAd.creative_payload) !== snapshotDigest(entry.ad.creative_payload)
        || request.purpose === 'patient_promotion' && (!active(currentAd) || !active(currentGroup))) fail('ad_sharing_inventory_changed');
      const next = await authorize({ models: afterModels, scope, reference: entry.reference, inventory: current, campaign, now: new Date() });
      if (next.fingerprint !== beforeAuth.get(entry.reference.ad_id).fingerprint || request.purpose === 'patient_promotion'
        && (next.entity && !active(next.entity) || next.group && !active(next.group))) fail('ad_sharing_inventory_changed');
    }));
  }
  if (request.purpose === 'lead_ad' || selectedAdId) result.selected = result.items[0] || null;
  if (reference) {
    const current = await leadReference({ models, ...request, attachIdentities });
    if (!current || ['provider', 'account_id', 'campaign_id', 'ad_id'].some(key => current[key] !== reference[key])) fail('ad_sharing_lead_changed');
  }
  if (!result.items.length) result.unavailableReason = 'no_authorized_ads';
  return result;
}

module.exports = { sharingInput, mediaUrl, creativeFromPost, creativeFromCache, creativeFromSnapshot, leadReference, loadAdSharing };
