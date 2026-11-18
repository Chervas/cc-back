'use strict';

const id = value => typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value);
const sharingKeys = ['version', 'body', 'title', 'kind', 'image_url', 'thumbnail_url', 'video_id', 'original_media_url', 'source_issue', 'has_variants'];

function validSharing(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.version === 1
    && Object.keys(value).every(key => sharingKeys.includes(key)) && sharingKeys.every(key => Object.hasOwn(value, key))
    && ['body', 'title'].every(key => typeof value[key] === 'string' && value[key].length <= 4000)
    && [null, 'IMAGE', 'VIDEO'].includes(value.kind) && typeof value.has_variants === 'boolean'
    && ['image_url', 'thumbnail_url', 'original_media_url'].every(key => value[key] === null || typeof value[key] === 'string' && value[key].length <= 4096)
    && (value.video_id === null || id(value.video_id))
    && (value.source_issue === null || typeof value.source_issue === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value.source_issue));
}

// This envelope is written only by normal AdsSync. It stores the bounded
// Reader projection, never Graph credentials, a raw response or client media.
function socialAdCreativeSnapshot({ accountId, ad, now = new Date() }) {
  const account = String(accountId || '').replace(/^act_/, '');
  if (![account, ad?.id, ad?.campaign_id, ad?.adset_id].every(id) || !Number.isFinite(+now)) {
    throw Object.assign(Error('invalid_social_ad_creative_identity'), { code: 'invalid_social_ad_creative_identity' });
  }
  let creative = ad.creative?.sharing;
  if (creative === undefined) creative = { version: 1, body: '', title: '', kind: null, image_url: null,
    thumbnail_url: null, video_id: null, original_media_url: null, source_issue: 'creative_not_synchronized', has_variants: false };
  if (!validSharing(creative)) throw Object.assign(Error('invalid_social_ad_creative_projection'), { code: 'invalid_social_ad_creative_projection' });
  return { version: 1, observedAt: now.toISOString(), creativeId: id(ad.creative?.id) ? ad.creative.id : null,
    reference: { provider: 'meta_ads', account_id: account,
    campaign_id: ad.campaign_id, group_id: ad.adset_id, ad_id: ad.id }, creative: structuredClone(creative) };
}

module.exports = { validSharing, socialAdCreativeSnapshot };
