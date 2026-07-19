'use strict';

const crypto = require('node:crypto');

const TICKET_PREFIX = 'ccwp1';
const TICKET_AAD = Buffer.from('clinicaclick-wordpress-bootstrap:v1', 'utf8');
const DEFAULT_TTL_MS = 15 * 60 * 1000;

class WebWordpressBootstrapTicketError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'WebWordpressBootstrapTicketError';
    this.code = code;
    this.status = status;
  }
}

function bootstrapKey(env = process.env) {
  const raw = String(env.MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY || '').trim();
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9_-]{43}=?$/.test(raw)) key = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) {
    throw new WebWordpressBootstrapTicketError(
      'web_wordpress_bootstrap_key_missing',
      'La descarga segura del plugin no está configurada.',
      503
    );
  }
  return key;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function parsePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value || '')) throw new Error('invalid');
  return Buffer.from(value, 'base64url');
}

function issueBootstrapTicket({
  installationId,
  actorId,
  token,
  siteClaimToken = null,
  env = process.env,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const installation = String(installationId || '').trim().toLowerCase();
  const actor = Number(actorId);
  const opaqueToken = String(token || '').trim();
  const claimToken = siteClaimToken === null || siteClaimToken === undefined
    ? null
    : String(siteClaimToken).trim();
  if (
    !/^[0-9a-f-]{36}$/.test(installation)
    || !Number.isSafeInteger(actor)
    || actor < 1
    || !/^ccw_[A-Za-z0-9_-]{32,}$/.test(opaqueToken)
    || (claimToken !== null && !/^[A-Za-z0-9_-]{43}$/.test(claimToken))
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(ttlMs)
    || ttlMs < 60_000
    || ttlMs > 60 * 60 * 1000
  ) {
    throw new WebWordpressBootstrapTicketError(
      'web_wordpress_bootstrap_ticket_invalid',
      'No se ha podido preparar la descarga segura del plugin.'
    );
  }
  const payload = Buffer.from(JSON.stringify({
    v: claimToken === null ? 1 : 2,
    installation_id: installation,
    actor_id: actor,
    token: opaqueToken,
    ...(claimToken === null ? {} : { site_claim_token: claimToken }),
    issued_at: now,
    expires_at: now + ttlMs,
  }), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', bootstrapKey(env), iv);
  cipher.setAAD(TICKET_AAD);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ticket: [TICKET_PREFIX, base64url(iv), base64url(ciphertext), base64url(tag)].join('.'),
    expires_at: new Date(now + ttlMs).toISOString(),
  };
}

function openBootstrapTicket(ticket, { env = process.env, now = Date.now() } = {}) {
  try {
    const parts = String(ticket || '').trim().split('.');
    if (parts.length !== 4 || parts[0] !== TICKET_PREFIX) throw new Error('invalid');
    const iv = parsePart(parts[1]);
    const ciphertext = parsePart(parts[2]);
    const tag = parsePart(parts[3]);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 64 || ciphertext.length > 4096) throw new Error('invalid');
    const decipher = crypto.createDecipheriv('aes-256-gcm', bootstrapKey(env), iv);
    decipher.setAAD(TICKET_AAD);
    decipher.setAuthTag(tag);
    const decoded = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    if (
      ![1, 2].includes(decoded?.v)
      || !/^[0-9a-f-]{36}$/.test(String(decoded.installation_id || ''))
      || !Number.isSafeInteger(decoded.actor_id)
      || decoded.actor_id < 1
      || !/^ccw_[A-Za-z0-9_-]{32,}$/.test(String(decoded.token || ''))
      || (decoded.v === 2 && !/^[A-Za-z0-9_-]{43}$/.test(String(decoded.site_claim_token || '')))
      || (decoded.v === 1 && decoded.site_claim_token !== undefined)
      || !Number.isSafeInteger(decoded.issued_at)
      || !Number.isSafeInteger(decoded.expires_at)
      || decoded.expires_at <= now
      || decoded.issued_at > now + 60_000
      || decoded.expires_at - decoded.issued_at > 60 * 60 * 1000
    ) throw new Error('invalid');
    return decoded;
  } catch (error) {
    if (error instanceof WebWordpressBootstrapTicketError) throw error;
    throw new WebWordpressBootstrapTicketError(
      'web_wordpress_bootstrap_ticket_invalid',
      'La descarga del plugin ha caducado o no es válida.',
      410
    );
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  TICKET_PREFIX,
  WebWordpressBootstrapTicketError,
  bootstrapKey,
  issueBootstrapTicket,
  openBootstrapTicket,
};
