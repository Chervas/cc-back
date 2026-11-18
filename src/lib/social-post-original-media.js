'use strict';

// Persist only original media already returned by the normal synchronizer.
// A thumbnail, post permalink or a new provider lookup is never an original.
function originalMediaFields(value) {
  if (typeof value !== 'string') return {};
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/(^|\.)(fbcdn\.net|cdninstagram\.com)$/.test(url.hostname)
      || [...url.searchParams.keys()].some(key => /^(access_token|authorization|password|secret)$/i.test(key))) return {};
    return { original_media_url: url.href };
  } catch { return {}; }
}

function instagramPostMedia(post) {
  const video = /^(VIDEO|REEL|REELS)$/.test(String(post.media_type || '').toUpperCase());
  return {
    media_url: video ? post.thumbnail_url || post.media_url || null : post.media_url || post.thumbnail_url || null,
    ...originalMediaFields(post.media_url),
  };
}

function facebookOriginalMedia(post, attachment) {
  const kind = String(attachment?.media_type || post.media_type || post.type || '').toUpperCase();
  if (/ALBUM|CAROUSEL/.test(kind) || attachment?.subattachments?.data?.length > 1) return {};
  if (/VIDEO|REEL/.test(kind)) return originalMediaFields(attachment?.media?.source || post.media_url);
  return originalMediaFields(post.media_url || attachment?.media?.image?.src || post.full_picture);
}

module.exports = { originalMediaFields, instagramPostMedia, facebookOriginalMedia };
