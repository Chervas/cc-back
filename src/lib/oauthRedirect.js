'use strict';

function normalizeOAuthReturnTo(candidate, { allowedOrigins, fallback }) {
  const safeFallback = String(fallback || '').trim();
  try {
    if (!candidate) return safeFallback;
    const parsed = new URL(String(candidate));
    if (parsed.username || parsed.password) return safeFallback;
    const allowlist = allowedOrigins instanceof Set
      ? allowedOrigins
      : new Set(Array.isArray(allowedOrigins) ? allowedOrigins : []);
    return allowlist.has(parsed.origin) ? parsed.toString() : safeFallback;
  } catch (_) {
    return safeFallback;
  }
}

module.exports = { normalizeOAuthReturnTo };
