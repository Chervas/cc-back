'use strict';

const JOINCHAT_ASSET_PATH = /\/wp-content\/plugins\/(?:creame-whatsapp-me|joinchat-premium)\//i;
const RESOURCE_TAG = /<(?:script|link|img|source)\b[^>]*>/gi;
const RESOURCE_ATTRIBUTE = /\b(?:src|href|data-src|data-href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const MARKUP_TAG = /<([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
const ID_OR_CLASS_ATTRIBUTE = /\b(id|class)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function hasJoinChatAsset(html) {
  const source = String(html || '');
  const resourceTags = source.match(RESOURCE_TAG) || [];

  return resourceTags.some((tag) => {
    RESOURCE_ATTRIBUTE.lastIndex = 0;
    let match;
    while ((match = RESOURCE_ATTRIBUTE.exec(tag)) !== null) {
      const value = match[1] || match[2] || match[3] || '';
      if (JOINCHAT_ASSET_PATH.test(value)) return true;
    }
    return false;
  });
}

function isJoinChatMarkupToken(value, attribute) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (attribute === 'id') {
    return tokens.some((token) => /^joinchat(?:$|[-_:])/i.test(token));
  }
  return tokens.some((token) => /^joinchat(?:$|--|__|-)/i.test(token));
}

function hasJoinChatMarkup(html) {
  // Selectors and HTML-looking strings inside JavaScript are not live DOM.
  // Removing non-markup contexts also avoids comments/documentation becoming
  // installation evidence.
  const markup = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');

  MARKUP_TAG.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = MARKUP_TAG.exec(markup)) !== null) {
    const attributes = tagMatch[2] || '';
    ID_OR_CLASS_ATTRIBUTE.lastIndex = 0;
    let attributeMatch;
    while ((attributeMatch = ID_OR_CLASS_ATTRIBUTE.exec(attributes)) !== null) {
      const attribute = String(attributeMatch[1] || '').toLowerCase();
      const value = attributeMatch[2] || attributeMatch[3] || attributeMatch[4] || '';
      if (isJoinChatMarkupToken(value, attribute)) return true;
    }
  }
  return false;
}

function detectLegacyJoinChat(html) {
  return hasJoinChatAsset(html) || hasJoinChatMarkup(html);
}

module.exports = {
  detectLegacyJoinChat,
  hasJoinChatAsset,
  hasJoinChatMarkup,
};
