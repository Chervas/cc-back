'use strict';

const { isIP } = require('node:net');

// A configured image may live on a CDN with a query string or an opaque path.
// Neither Clinicaclick nor the model needs to download it during a conversation.
function promotionImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s<>\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !host.includes('.') ||
      isIP(host) ||
      host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host) ||
      [...url.searchParams.keys()].some((k) => /^(access_token|client_secret|authorization)$/i.test(k))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

module.exports = { promotionImageUrl };
