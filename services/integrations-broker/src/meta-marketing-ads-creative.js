'use strict';
// A bounded projection of one observed ad creative. Never an assembled dynamic
// impression; original video URLs are added only by the authorized Ads reader.
const { fail } = require('./errors');
const { createHash } = require('node:crypto');
const M = require('./meta-marketing-contract');
const KEYS = ['version','body','title','kind','image_url','thumbnail_url','video_id','original_media_url','source_issue','has_variants'];
const ISSUES = ['creative_variants_require_selection','carousel_not_supported','creative_copy_invalid','video_source_unavailable','video_source_permission_denied','original_media_unavailable','creative_relationship_ambiguous','creative_alternatives_limit_exceeded','image_source_permission_denied','creative_not_synchronized'];
const MAX_ALTERNATIVES = 10, MAX_PROJECTION_BYTES = 64000;
const V2_KEYS = [...KEYS, 'copies', 'alternatives'];
const OPTION_KEYS = ['variant_id','copy_id','kind','image_url','image_hash','thumbnail_url','video_id','original_media_url','source_issue','provenance'];
const imageHash = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value) ? value.toLowerCase() : null;
const labelName = value => typeof value === 'string' && value.length <= 128 && Buffer.byteLength(value) <= 256
  && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
function provenance(value) {
  return exact(value,['source','path']) && typeof value.path === 'string' && value.path.length <= 128 && (
    value.source === 'creative' && value.path === 'default'
    || value.source === 'object_story_spec' && ['link_data','video_data','template_data','photo_data','text_data'].includes(value.path)
    || value.source === 'asset_feed_spec' && /^(images|videos|asset_customization_rules)\[(?:[0-9]|[1-4][0-9])\]$/.test(value.path)
    || value.source === 'platform_customizations' && /^[a-z][a-z0-9_]{0,63}$/.test(value.path));
}
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
function projectV1(input) {
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
function validateV1(value) {
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
function videoSourceV1(value, raw) {
  const result = validateV1(value);
  if (result.kind !== 'VIDEO' || result.has_variants || !result.video_id || result.source_issue !== 'video_source_unavailable') return result;
  if (raw?.error && [10,200].includes(raw.error.code)) return { ...result,source_issue:'video_source_permission_denied' };
  if (raw == null || raw.error) return result;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.id !== result.video_id) fail('provider_failed');
  const source = cdn(raw.source);
  return source ? { ...result,original_media_url:source,source_issue:null } : result;
}
// V2 keeps a bounded set of source-related choices. Shared copy is stored once:
// an option points to exactly one copy_id, never a Cartesian combination.
function projectV2(input) {
  const c = object(input), base = projectV1(input);
  const result = { ...base, version: 2, copies: [], alternatives: [] };
  if (base.source_issue === 'carousel_not_supported') return result;
  const unavailable = issue => ({ ...result, body: '', title: '', image_url: null,
    video_id: null, original_media_url: null, source_issue: issue, copies: [], alternatives: [] });
  const spec = object(c.object_story_spec), feed = object(c.asset_feed_spec), platforms = object(c.platform_customizations);
  const malformedCopy = [...list(feed.bodies),...list(feed.titles)].some(value => typeof value !== 'string'
    && (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.text !== 'string'));
  if (malformedCopy) return unavailable('creative_copy_invalid');
  if (list(feed.ad_formats).some(value => typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value))) {
    return unavailable('creative_relationship_ambiguous');
  }
  if ([...list(feed.images),...list(feed.videos)].some(value => !value || typeof value !== 'object' || Array.isArray(value))) fail('provider_failed');
  const hashOnly = list(feed.images).some(image => image.hash != null && !cdn(image.url))
    || c.image_hash != null && !cdn(c.image_url)
    || Object.values(spec).some(block => block?.image_hash != null && !cdn(block?.image_url) && !cdn(block?.picture));
  if (!base.has_variants && !hashOnly) return result;
  result.has_variants = true;
  const blocks = ['link_data','video_data','template_data','photo_data','text_data']
    .filter(key => spec[key]).map(key => ({ key, value: spec[key] }));
  const bodies = strings([c.body,...blocks.map(b => b.value.message),...list(feed.bodies).map(v => typeof v === 'string' ? v : v?.text)],4000);
  const titles = strings([c.title,...blocks.map(b => b.value.name || b.value.title),...list(feed.titles).map(v => typeof v === 'string' ? v : v?.text)],1024);
  if (bodies.invalid || titles.invalid) return unavailable('creative_copy_invalid');
  const single = values => values.length <= 1 ? values[0] || '' : null;
  const common = { body: single(bodies.values), title: single(titles.values) };
  const copies = new Map(), options = new Map();
  let ambiguous = false, invalidCopy = false;
  const copy = (body, title) => {
    const b = strings([body],4000), t = strings([title],1024);
    if (b.invalid || t.invalid) { invalidCopy = true; return null; }
    if (body === null || title === null) { ambiguous = true; return null; }
    const item = { copy_id: hash([b.values[0] || '',t.values[0] || '']), body: b.values[0] || '', title: t.values[0] || '' };
    copies.set(item.copy_id,item); return item;
  };
  const labels = asset => {
    if (asset.adlabels == null) return [];
    if (!Array.isArray(asset.adlabels) || asset.adlabels.length > 50) { ambiguous = true; return []; }
    return asset.adlabels.map(label => {
      if (!label || !labelName(label.name)) { ambiguous = true; return ''; }
      return label.name;
    });
  };
  const imageAssets = list(feed.images).map((raw,index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { ambiguous = true; raw = {}; }
    if (raw.hash != null && !imageHash(raw.hash)) ambiguous = true;
    return { kind:'IMAGE',image_url:cdn(raw.url),image_hash:imageHash(raw.hash),
      video_id:null,thumbnail_url:null,labels:labels(raw),path:`images[${index}]` };
  });
  const videoAssets = list(feed.videos).map((raw,index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !M.graphId(raw.video_id)) { ambiguous = true; raw = {}; }
    return { kind:'VIDEO',image_url:null,video_id:raw.video_id || null,thumbnail_url:cdn(raw.thumbnail_url),labels:labels(raw),path:`videos[${index}]` };
  });
  const media = [...imageAssets,...videoAssets];
  const add = (asset, body, title, provenance) => {
    const selectedCopy = copy(body,title); if (!selectedCopy) return;
    const option = { variant_id:'',copy_id:selectedCopy.copy_id,kind:asset.kind,image_url:asset.image_url || null,image_hash:asset.image_hash || null,
      thumbnail_url:asset.thumbnail_url || null,video_id:asset.video_id || null,original_media_url:null,
      source_issue:asset.kind === 'VIDEO' ? 'video_source_unavailable' : asset.image_url ? null : 'original_media_unavailable',provenance };
    if (option.kind === 'VIDEO' && !M.graphId(option.video_id)) { ambiguous = true; return; }
    option.variant_id = hash([c.id || null,option.kind,option.image_hash || option.image_url,option.video_id,option.copy_id]);
    if (!options.has(option.variant_id)) options.set(option.variant_id,option);
  };
  const ownCopy = (block, story = false) => {
    const body = strings([block.body,block.message],4000),title = strings([block.title,...(story?[block.name]:[])],1024);
    if (body.invalid || title.invalid) invalidCopy = true;
    if (body.values.length > 1 || title.values.length > 1) ambiguous = true;
    return {body:body.values.length ? single(body.values) : common.body,
      title:title.values.length ? single(title.values) : common.title};
  };
  const ownMedia = block => {
    const video = block.video_id, image = cdn(block.image_url) || cdn(block.picture);
    if (video != null) {
      if (!M.graphId(video)) { ambiguous = true; return null; }
      return {kind:'VIDEO',video_id:video,image_url:null,thumbnail_url:image || cdn(c.thumbnail_url)};
    }
    if (block.image_hash != null && !imageHash(block.image_hash)) { ambiguous = true; return null; }
    return image || imageHash(block.image_hash) || block.image_url != null || block.picture != null ? {kind:'IMAGE',video_id:null,image_url:image,
      image_hash:imageHash(block.image_hash),thumbnail_url:null} : null;
  };
  const rules = list(feed.asset_customization_rules);
  if (rules.length && Object.keys(platforms).length) return unavailable('creative_relationship_ambiguous');
  if (rules.length) {
    const textAssets = (values, max) => values.map(raw => {
      if (typeof raw === 'string') return { text: raw, labels: [] };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { ambiguous = true; return {text:'',labels:[]}; }
      const value = strings([raw.text],max); if (value.invalid) invalidCopy = true;
      return {text:value.values[0] || '',labels:labels(raw)};
    });
    const bodyAssets = textAssets(list(feed.bodies),4000), titleAssets = textAssets(list(feed.titles),1024);
    const resolve = (rule, key, assets, fallback) => {
      if (rule[key] == null) return fallback;
      const label = rule[key];
      if (!exact(label,['name']) || !labelName(label.name)) { ambiguous = true; return null; }
      const matches = assets.filter(asset => asset.labels.includes(label.name));
      if (matches.length !== 1) { ambiguous = true; return null; }
      return matches[0];
    };
    const covered = new Set();
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index];
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)
        || rule.image_label != null && rule.video_label != null) { ambiguous = true; continue; }
      const asset = rule.image_label != null ? resolve(rule,'image_label',imageAssets,null)
        : rule.video_label != null ? resolve(rule,'video_label',videoAssets,null) : media.length === 1 ? media[0] : null;
      const body = resolve(rule,'body_label',bodyAssets,common.body), title = resolve(rule,'title_label',titleAssets,common.title);
      if (!asset || body === null || title === null) { ambiguous = true; continue; }
      covered.add(asset.path);
      add(asset, typeof body === 'string' ? body : body.text, typeof title === 'string' ? title : title.text,
        {source:'asset_feed_spec',path:`asset_customization_rules[${index}]`});
    }
    // Unbound assets/copy cannot silently disappear or acquire arbitrary pairs.
    if (media.some(asset => !covered.has(asset.path))
      || bodyAssets.some(item => ![...copies.values()].some(c => c.body === item.text))
      || titleAssets.some(item => ![...copies.values()].some(c => c.title === item.text))) ambiguous = true;
  } else if (media.length) {
    if (common.body === null || common.title === null) ambiguous = true;
    else for (const asset of media) add(asset,common.body,common.title,{source:'asset_feed_spec',path:asset.path});
  } else {
    const direct = ownMedia(c), own = ownCopy(c);
    if (direct) add(direct,own.body,own.title,{source:'creative',path:'default'});
    for (const {key,value} of blocks) {
      const asset = ownMedia(value), own = ownCopy(value,true);
      if (asset) add(asset,own.body,own.title,{source:'object_story_spec',path:key});
    }
  }
  // An explicit default/story video ID remains an observed original even when
  // feed media also exist. A top-level image may only be a video poster or an
  // alternate rendition, so it is not invented as an additional feed choice.
  if (media.length) {
    const knownVideos = new Set(media.filter(asset => asset.kind === 'VIDEO').map(asset => asset.video_id));
    for (const {block,source,path,story} of [{block:c,source:'creative',path:'default',story:false},
      ...blocks.map(({key,value})=>({block:value,source:'object_story_spec',path:key,story:true}))]) {
      if (!block.video_id || knownVideos.has(block.video_id)) continue;
      const asset = ownMedia(block),own = ownCopy(block,story);
      if (asset) { add(asset,own.body,own.title,{source,path});knownVideos.add(block.video_id); }
    }
  }
  if (Object.keys(platforms).length > 10) return unavailable('creative_alternatives_limit_exceeded');
  for (const [key,block] of Object.entries(platforms)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !block || typeof block !== 'object' || Array.isArray(block)) { ambiguous = true; continue; }
    const asset = ownMedia(block) || (media.length === 1 ? media[0] : ownMedia(c)), own = ownCopy(block);
    if (!asset) { ambiguous = true; continue; }
    add(asset,own.body,own.title,{source:'platform_customizations',path:key});
  }
  if (invalidCopy) return unavailable('creative_copy_invalid');
  if (ambiguous || !options.size) return unavailable('creative_relationship_ambiguous');
  const used = new Set([...options.values()].map(option => option.copy_id));
  const value = { ...unavailable('creative_variants_require_selection'),
    copies:[...copies.values()].filter(c => used.has(c.copy_id)),alternatives:[...options.values()] };
  if (value.alternatives.length > MAX_ALTERNATIVES || Buffer.byteLength(JSON.stringify(value)) > MAX_PROJECTION_BYTES) {
    return unavailable('creative_alternatives_limit_exceeded');
  }
  return value;
}

function project(input, version = 1) {
  if (![1,2].includes(version)) fail('provider_failed');
  return version === 2 ? projectV2(input) : projectV1(input);
}
function validate(value, expectedVersion = null) {
  if (expectedVersion !== null && value?.version !== expectedVersion) fail('provider_failed');
  if (value?.version === 1) return validateV1(value);
  if (!exact(value,V2_KEYS) || value.version !== 2 || !Array.isArray(value.copies) || value.copies.length > MAX_ALTERNATIVES
    || !Array.isArray(value.alternatives) || value.alternatives.length > MAX_ALTERNATIVES
    || Buffer.byteLength(JSON.stringify(value)) > MAX_PROJECTION_BYTES) fail('provider_failed');
  const { copies,alternatives,...base } = value;
  validateV1({...base,version:1});
  const copyIds = new Set(),variantIds = new Set(),usedCopies = new Set();
  for (const copy of copies) {
    if (!exact(copy,['copy_id','body','title']) || typeof copy.body !== 'string' || typeof copy.title !== 'string'
      || copy.copy_id !== hash([copy.body,copy.title]) || copyIds.has(copy.copy_id)) fail('provider_failed');
    validateV1({version:1,body:copy.body,title:copy.title,kind:null,image_url:null,thumbnail_url:null,video_id:null,
      original_media_url:null,source_issue:'original_media_unavailable',has_variants:false});
    copyIds.add(copy.copy_id);
  }
  for (const option of alternatives) {
    if (!exact(option,OPTION_KEYS) || typeof option.variant_id !== 'string' || !/^[a-f0-9]{64}$/.test(option.variant_id)
      || variantIds.has(option.variant_id) || !copyIds.has(option.copy_id) || !['IMAGE','VIDEO'].includes(option.kind)
      || !provenance(option.provenance)
      || !(option.source_issue === null || option.kind === 'VIDEO' && ['video_source_unavailable','video_source_permission_denied'].includes(option.source_issue)
        || option.kind === 'IMAGE' && ['original_media_unavailable','image_source_permission_denied'].includes(option.source_issue))
      || option.image_hash !== null && imageHash(option.image_hash) !== option.image_hash) fail('provider_failed');
    const copy = copies.find(copy => copy.copy_id === option.copy_id);
    validateV1({version:1,body:copy.body,title:copy.title,kind:option.kind,image_url:option.image_url,thumbnail_url:option.thumbnail_url,
      video_id:option.video_id,original_media_url:option.original_media_url,source_issue:option.source_issue,has_variants:false});
    if (option.kind === 'VIDEO' && (!M.graphId(option.video_id) || option.image_hash !== null) || option.kind === 'IMAGE' && option.video_id !== null) fail('provider_failed');
    variantIds.add(option.variant_id);usedCopies.add(option.copy_id);
  }
  if (copies.length !== usedCopies.size || alternatives.length && (!value.has_variants || value.source_issue !== 'creative_variants_require_selection')
    || !value.has_variants && (copies.length || alternatives.length)) fail('provider_failed');
  return structuredClone(value);
}
function videoIds(value) {
  const result = validate(value);
  return [...new Set(result.version === 2 && result.has_variants
    ? result.alternatives.filter(a => a.kind === 'VIDEO' && a.source_issue === 'video_source_unavailable').map(a => a.video_id)
    : result.kind === 'VIDEO' && !result.has_variants && result.video_id && result.source_issue === 'video_source_unavailable' ? [result.video_id] : [])];
}
function imageHashes(value) {
  const result = validate(value);
  return result.version === 2 ? [...new Set(result.alternatives.filter(a => a.kind === 'IMAGE' && a.image_hash
    && !a.image_url && a.source_issue === 'original_media_unavailable').map(a => a.image_hash))] : [];
}
function imageSources(value, sources) {
  const result = validate(value);
  if (result.version !== 2) return result;
  result.alternatives = result.alternatives.map(option => {
    if (option.kind !== 'IMAGE' || !option.image_hash || option.image_url || option.source_issue !== 'original_media_unavailable') return option;
    const raw = sources?.[option.image_hash];
    if (!raw) return option;
    if (raw.error && [10,200].includes(raw.error.code)) return {...option,source_issue:'image_source_permission_denied'};
    if (raw.hash !== option.image_hash) fail('provider_failed');
    const url = cdn(raw.url);
    return url ? {...option,image_url:url,source_issue:null} : option;
  });
  return validate(result,2);
}
function videoSources(value, sources, permissionDenied = false) {
  const result = validate(value);
  if (result.version === 1) return videoSourceV1(result,permissionDenied ? {error:{code:200}} : sources?.[result.video_id]);
  if (!result.has_variants) {
    const {copies,alternatives,...base} = result;
    return {...videoSourceV1({...base,version:1},permissionDenied ? {error:{code:200}} : sources?.[result.video_id]),version:2,copies,alternatives};
  }
  result.alternatives = result.alternatives.map(option => {
    if (option.kind !== 'VIDEO' || option.source_issue !== 'video_source_unavailable') return option;
    const copy = result.copies.find(copy => copy.copy_id === option.copy_id);
    const hydrated = videoSourceV1({version:1,body:copy.body,title:copy.title,kind:'VIDEO',image_url:null,
      thumbnail_url:option.thumbnail_url,video_id:option.video_id,original_media_url:null,source_issue:option.source_issue,has_variants:false},
      permissionDenied ? {error:{code:200}} : sources?.[option.video_id]);
    return {...option,original_media_url:hydrated.original_media_url,source_issue:hydrated.source_issue};
  });
  return validate(result,2);
}
function videoSource(value, raw) {
  if (value?.version !== 2) return videoSourceV1(value,raw);
  return videoSources(value,raw?.id ? {[raw.id]:raw} : {},!!raw?.error && [10,200].includes(raw.error.code));
}
module.exports = { project,validate,videoSource,videoSources,videoIds,imageHashes,imageSources,cdn,KEYS,ISSUES,MAX_ALTERNATIVES,MAX_PROJECTION_BYTES };
