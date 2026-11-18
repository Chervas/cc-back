'use strict';

// Purpose-bound bearer capabilities: URLs contain neither email addresses nor
// contact identifiers. Browser access never re-renders a current template.
const crypto = require('crypto');
const { encryptEmailValue, decryptEmailValue } = require('./emailSensitiveEnvelope');
const LINK_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;
const PREVIEW_LINKS = Object.freeze({
  unsubscribe_url: 'https://example.test/email/baja',
  browser_view_url: 'https://example.test/api/email/browser-view?preview=1',
  preferences_url: 'https://example.test/email/preferencias?preview=1',
});

function invalid() {
  return Object.assign(new Error('El enlace de email no es válido o ha caducado.'), { code: 'marketing_email_link_invalid', status: 404 });
}

function systemVariables(links = PREVIEW_LINKS) {
  const result = {};
  for (const key of ['unsubscribe_url', 'browser_view_url', 'preferences_url']) {
    if (links[key]) { result[key] = links[key]; result[key.toUpperCase()] = links[key]; }
  }
  return result;
}

function publicBaseUrl() {
  const raw = String(process.env.EMAIL_PUBLIC_APP_URL || process.env.FRONTEND_PUBLIC_URL || 'https://crm.clinicaclick.com').replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid_public_base');
    return raw;
  } catch {
    throw Object.assign(new Error('La URL pública de email no está configurada correctamente.'), { code: 'marketing_email_public_url_invalid', status: 503 });
  }
}

function issueCapability({ publicId, recipientHash, scopeKey, expiresAt }, purpose) {
  const claims = { m: publicId, r: recipientHash, s: scopeKey, e: expiresAt, p: purpose };
  return `v1.${Buffer.from(encryptEmailValue(JSON.stringify(claims), `marketing-public-link:v1:${purpose}`)).toString('base64url')}`;
}

function readCapability(token, purpose, { now = Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || !/^v1\.[A-Za-z0-9_-]{100,1800}$/.test(token)) throw invalid();
    const claims = JSON.parse(decryptEmailValue(Buffer.from(token.slice(3), 'base64url').toString('utf8'), `marketing-public-link:v1:${purpose}`));
    if (claims.p !== purpose || !/^em_[0-9a-f-]{36}$/.test(claims.m)
      || !/^[a-f0-9]{64}$/.test(claims.r) || !/^(?:clinic|group):[1-9]\d*$/.test(claims.s)
      || !Number.isSafeInteger(claims.e) || claims.e <= now) throw invalid();
    return claims;
  } catch { throw invalid(); }
}

function messageLinks({ publicId, recipientHash, scopeKey, unsubscribeUrl, now = Date.now() }) {
  const expiresAt = now + LINK_LIFETIME_MS;
  const claims = { publicId, recipientHash, scopeKey, expiresAt };
  const base = publicBaseUrl();
  return {
    unsubscribe_url: unsubscribeUrl,
    browser_view_url: `${base}/api/email/browser-view?token=${issueCapability(claims, 'browser')}`,
    preferences_url: `${base}/email/preferencias?token=${issueCapability(claims, 'preferences')}`,
    expires_at: expiresAt,
  };
}

function snapshotSignature(value) {
  const key = String(process.env.EMAIL_DATA_ENCRYPTION_KEY || '').trim();
  if (key.length < 16) throw Object.assign(new Error('email_data_encryption_key_not_configured'), { code: 'email_data_encryption_key_not_configured' });
  // MySQL JSON normalizes object key order. Sign a canonical representation so
  // an unchanged outbox snapshot survives a database round-trip.
  const canonical = input => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(name => [name, canonical(input[name])]));
    return input;
  };
  return crypto.createHmac('sha256', key).update(`marketing-email-snapshot-v1\n${JSON.stringify(canonical(value))}`).digest('hex');
}

function sealSnapshot({ publicId, recipientHash, scopeKey, scopeLabel, expiresAt, rendered }) {
  const value = { version: 1, public_id: publicId, recipient_hash: recipientHash, scope_key: scopeKey, scope_label: scopeLabel || 'tu clínica', expires_at: expiresAt, rendered };
  return { ...value, signature: snapshotSignature(value) };
}

function readSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || typeof snapshot.signature !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.signature)) throw invalid();
  const { signature, ...value } = snapshot;
  const expected = snapshotSignature(value);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
  if (typeof value.rendered?.html !== 'string' || typeof value.rendered?.text !== 'string' || typeof value.rendered?.subject !== 'string') throw invalid();
  return value;
}

module.exports = { LINK_LIFETIME_MS, PREVIEW_LINKS, systemVariables, publicBaseUrl, messageLinks, readCapability, sealSnapshot, readSnapshot };
