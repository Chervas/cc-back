'use strict';

function profilePictureUrl(value, { providerOnly = false } = {}) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const provider = /(?:^|\.)(?:whatsapp\.net|fbcdn\.net)$/i.test(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (providerOnly && !provider)) return null;
    for (const key of url.searchParams.keys()) {
      if (/(?:token|secret|signature|credential|password|authorization|appsecret_proof|api[_-]?key|key[_-]?pair[_-]?id)/i.test(key)
        || ['sig', 'policy'].includes(key.toLowerCase()) || (key.toLowerCase() === 'oh' && !provider)) return null;
    }
    return value;
  } catch {
    return null;
  }
}

module.exports = { profilePictureUrl };
