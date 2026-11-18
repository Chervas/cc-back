'use strict';
// A bounded projection of one observed ad creative. Never an assembled dynamic
// impression; original video URLs are added only by the authorized Ads reader.
const { fail } = require('./errors');
const M = require('./meta-marketing-contract');
const KEYS = ['version','body','title','kind','image_url','thumbnail_url','video_id','original_media_url','source_issue','has_variants'];
const ISSUES = ['creative_variants_require_selection','carousel_not_supported','creative_copy_invalid','video_source_unavailable','video_source_permission_denied','original_media_unavailable'];
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = v => Array.isArray(v) ? v : [];
function cdn(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash
    && /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i.test(u.hostname) ? u.href : null; } catch { return null; }
}
function strings(values, max) {
  let invalid = false;
  const result = [...new Set(values.filter(v => v != null && v !== '').map(v => {
    if (typeof v !== 'string' || v.length > max || Buffer.byteLength(v) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) { invalid = true; return ''; }
    return v.trim();
  }).filter(Boolean))];
  return { values: result, invalid };
}
function project(input) {
  const c = object(input), spec = object(c.object_story_spec), feed = object(c.asset_feed_spec);
  for(const key of ['object_story_spec','asset_feed_spec','platform_customizations'])if(c[key]!=null&&(!c[key]||typeof c[key]!=='object'||Array.isArray(c[key])))fail('provider_failed');
  for(const key of ['images','videos','bodies','titles','ad_formats','asset_customization_rules'])if(feed[key]!=null&&(!Array.isArray(feed[key])||feed[key].length>50))fail('provider_failed');
  for(const key of ['link_data','video_data','template_data','photo_data','text_data']){
    const block=spec[key];if(block!=null&&(!block||typeof block!=='object'||Array.isArray(block)))fail('provider_failed');
    if(block?.child_attachments!=null&&(!Array.isArray(block.child_attachments)||block.child_attachments.length>50))fail('provider_failed');
  }
  const blocks = [spec.link_data,spec.video_data,spec.template_data,spec.photo_data,spec.text_data].filter(Boolean).map(object);
  const children = blocks.flatMap(b => list(b.child_attachments));
  const bodies = strings([c.body,...blocks.map(b => b.message),...list(feed.bodies).map(v => typeof v === 'string' ? v : v?.text)],4000);
  const titles = strings([c.title,...blocks.map(b => b.name || b.title),...list(feed.titles).map(v => typeof v === 'string' ? v : v?.text)],1024);
  // image_url is the observed creative's authoritative image. Story pictures
  // are often alternate resolutions of that same asset, so they are fallbacks
  // rather than independent variants. Explicit feed variants stay blocked.
  const primaryImage = cdn(c.image_url);
  const feedImages = list(feed.images).map(v => cdn(v?.url)).filter(Boolean);
  const storyImages = blocks.map(b => cdn(b.image_url) || cdn(b.picture)).filter(Boolean);
  const images = [...new Set(primaryImage ? [primaryImage] : feedImages.length ? feedImages : storyImages)];
  const videos = [...new Set([c.video_id,spec.video_data?.video_id,...list(feed.videos).map(v => v?.video_id)].filter(v => v != null))];
  if (videos.some(v => !M.graphId(v))) fail('provider_failed');
  const carousel = children.length > 0 || list(feed.ad_formats).some(v => /CAROUSEL/i.test(String(v)));
  const variants = carousel || bodies.values.length > 1 || titles.values.length > 1 || images.length > 1 || videos.length > 1
    || list(feed.images).length > 1 || list(feed.videos).length > 1 || list(feed.asset_customization_rules).length > 0
    || Object.keys(object(c.platform_customizations)).length > 0 || list(feed.ad_formats).length > 1;
  const kind = videos.length || spec.video_data ? 'VIDEO' : images.length ? 'IMAGE' : null;
  const issue = carousel ? 'carousel_not_supported' : variants ? 'creative_variants_require_selection'
    : bodies.invalid || titles.invalid ? 'creative_copy_invalid' : kind === 'VIDEO' ? 'video_source_unavailable' : kind === 'IMAGE' ? null : 'original_media_unavailable';
  return { version:1,body:bodies.values.length === 1 ? bodies.values[0] : '',title:titles.values.length === 1 ? titles.values[0] : '',kind,
    image_url:!variants && kind === 'IMAGE' ? images[0] : null,thumbnail_url:cdn(c.thumbnail_url),
    video_id:videos.length === 1 ? videos[0] : null,original_media_url:null,source_issue:issue,has_variants:variants };
}
function validate(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== KEYS.slice().sort().join(',')
    || value.version !== 1 || typeof value.body !== 'string' || value.body.length > 4000 || Buffer.byteLength(value.body) > 4000 || typeof value.title !== 'string' || value.title.length > 1024 || Buffer.byteLength(value.title) > 1024
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.body + value.title)
    || ![null,'IMAGE','VIDEO'].includes(value.kind) || typeof value.has_variants !== 'boolean'
    || value.source_issue !== null && !ISSUES.includes(value.source_issue)
    || value.video_id !== null && !M.graphId(value.video_id)) fail('provider_failed');
  for (const key of ['image_url','thumbnail_url','original_media_url']) if (value[key] !== null && cdn(value[key]) !== value[key]) fail('provider_failed');
  if (value.kind !== 'IMAGE' && value.image_url !== null || value.kind !== 'VIDEO' && value.original_media_url !== null
    || value.has_variants && value.source_issue === null
    || value.source_issue === null && (value.kind === 'IMAGE' ? !value.image_url : value.kind === 'VIDEO' ? !value.video_id || !value.original_media_url : true)) fail('provider_failed');
  return structuredClone(value);
}
function videoSource(value, raw) {
  const result = validate(value);
  if (result.kind !== 'VIDEO' || result.has_variants || !result.video_id || result.source_issue !== 'video_source_unavailable') return result;
  if (raw?.error && [10,200].includes(raw.error.code)) return { ...result,source_issue:'video_source_permission_denied' };
  if (raw == null || raw.error) return result;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.id !== result.video_id) fail('provider_failed');
  const source = cdn(raw.source);
  return source ? { ...result,original_media_url:source,source_issue:null } : result;
}
module.exports = { project,validate,videoSource,cdn,KEYS,ISSUES };
