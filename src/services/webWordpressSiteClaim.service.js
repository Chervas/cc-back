'use strict';

const axios = require('axios');
const crypto = require('node:crypto');
const {
  normalizeResolvedAddresses,
  resolvePublicAddresses,
  resolveSafeHttpTarget,
} = require('../lib/safeHttpTarget');
const { normalizeSiteUrl, WebPublicationServiceError } = require('./webPublications.service');

const SITE_CLAIM_PATH = '/.well-known/clinicaclick-wordpress-claim';
const MAX_SITE_CLAIM_RESPONSE_BYTES = 4096;
const DEFAULT_SITE_CLAIM_TIMEOUT_MS = 5000;

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function siteClaimError(code, message, status = 409, details = undefined) {
  return new WebPublicationServiceError(code, message, status, details);
}

function siteClaimUrl(siteUrl) {
  const normalized = normalizeSiteUrl(siteUrl).url;
  const url = new URL(SITE_CLAIM_PATH, `${normalized}/`);
  if (
    url.protocol !== 'https:'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== SITE_CLAIM_PATH
  ) {
    throw siteClaimError(
      'web_wordpress_site_claim_target_invalid',
      'No se puede comprobar de forma segura el control de ese WordPress.',
      422
    );
  }
  return { site_url: normalized, claim_url: url.toString() };
}

function addressSet(rows) {
  return normalizeResolvedAddresses(rows)
    .map((item) => `${item.family}:${item.address}`)
    .sort();
}

function sameAddressSet(left, right) {
  const a = addressSet(left);
  const b = addressSet(right);
  return a.length > 0 && a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseClaimDocument(value) {
  let decoded = value;
  if (Buffer.isBuffer(decoded)) decoded = decoded.toString('utf8');
  if (typeof decoded === 'string') {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      decoded = null;
    }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw siteClaimError(
      'web_wordpress_site_claim_invalid',
      'WordPress no ha devuelto una prueba de control válida.'
    );
  }
  const allowed = new Set(['installation_id', 'claim_token_sha256', 'canonical_home_url']);
  if (Object.keys(decoded).some((field) => !allowed.has(field))) {
    throw siteClaimError(
      'web_wordpress_site_claim_invalid',
      'WordPress no ha devuelto una prueba de control válida.'
    );
  }
  return decoded;
}

async function verifyWordpressSiteClaim({
  installationId,
  siteUrl,
  expectedClaimTokenHash,
  httpClient = axios,
  resolveTarget = resolveSafeHttpTarget,
  resolveAddresses = resolvePublicAddresses,
  timeoutMs = DEFAULT_SITE_CLAIM_TIMEOUT_MS,
} = {}) {
  const installation = String(installationId || '').trim().toLowerCase();
  const expectedDigest = String(expectedClaimTokenHash || '').trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installation)
    || !/^[a-f0-9]{64}$/.test(expectedDigest)
  ) {
    throw siteClaimError(
      'web_wordpress_site_claim_required',
      'Vuelve a descargar e instalar el plugin para demostrar el control de este WordPress.'
    );
  }
  const target = siteClaimUrl(siteUrl);
  let safeTarget;
  try {
    safeTarget = await resolveTarget(target.claim_url);
    if (!safeTarget || !sameAddressSet(safeTarget.addresses, safeTarget.addresses)) throw new Error('invalid target');
  } catch {
    throw siteClaimError(
      'web_wordpress_site_claim_target_blocked',
      'No se puede comprobar el control de un destino no público.'
    );
  }

  let response;
  try {
    response = await httpClient.get(safeTarget.url, {
      timeout: Math.max(500, Math.min(10000, Number(timeoutMs) || DEFAULT_SITE_CLAIM_TIMEOUT_MS)),
      maxRedirects: 0,
      maxContentLength: MAX_SITE_CLAIM_RESPONSE_BYTES,
      maxBodyLength: MAX_SITE_CLAIM_RESPONSE_BYTES,
      responseType: 'text',
      transformResponse: [(body) => body],
      decompress: false,
      proxy: false,
      validateStatus: () => true,
      httpAgent: safeTarget.httpAgent,
      httpsAgent: safeTarget.httpsAgent,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'cache-control': 'no-cache, no-store, max-age=0',
        pragma: 'no-cache',
        'user-agent': 'Clinicaclick-WordPress-Claim/1.0',
      },
    });
  } catch {
    throw siteClaimError(
      'web_wordpress_site_claim_unavailable',
      'No se ha podido comprobar el control del WordPress.'
    );
  } finally {
    safeTarget.httpAgent?.destroy?.();
    safeTarget.httpsAgent?.destroy?.();
  }

  const status = Number(response?.status || 0);
  const contentType = String(response?.headers?.['content-type'] || response?.headers?.['Content-Type'] || '')
    .split(';')[0].trim().toLowerCase();
  const rawBody = Buffer.isBuffer(response?.data)
    ? response.data
    : Buffer.from(String(response?.data || ''), 'utf8');
  if (
    status >= 300 && status < 400
    || status !== 200
    || contentType !== 'application/json'
    || rawBody.length < 2
    || rawBody.length > MAX_SITE_CLAIM_RESPONSE_BYTES
  ) {
    throw siteClaimError(
      status >= 300 && status < 400
        ? 'web_wordpress_site_claim_redirect_blocked'
        : 'web_wordpress_site_claim_invalid',
      'WordPress no ha devuelto una prueba de control válida.'
    );
  }

  let revalidated;
  try {
    revalidated = await resolveAddresses(safeTarget.hostname);
  } catch {
    throw siteClaimError(
      'web_wordpress_site_claim_dns_changed',
      'La resolución DNS cambió durante la comprobación del WordPress.'
    );
  }
  if (!sameAddressSet(safeTarget.addresses, revalidated)) {
    throw siteClaimError(
      'web_wordpress_site_claim_dns_changed',
      'La resolución DNS cambió durante la comprobación del WordPress.'
    );
  }

  const document = parseClaimDocument(rawBody);
  let canonical;
  try {
    canonical = normalizeSiteUrl(document.canonical_home_url).url;
  } catch {
    canonical = null;
  }
  if (
    !secureEqual(document.installation_id, installation)
    || !secureEqual(String(document.claim_token_sha256 || '').toLowerCase(), expectedDigest)
    || !canonical
    || !secureEqual(canonical, target.site_url)
  ) {
    throw siteClaimError(
      'web_wordpress_site_claim_mismatch',
      'La prueba pública pertenece a otra instalación o a otro WordPress.'
    );
  }
  return {
    installation_id: installation,
    site_url: canonical,
    site_url_hash: crypto.createHash('sha256').update(canonical).digest('hex'),
    claim_token_hash: expectedDigest,
    verified_addresses: addressSet(revalidated),
  };
}

module.exports = {
  DEFAULT_SITE_CLAIM_TIMEOUT_MS,
  MAX_SITE_CLAIM_RESPONSE_BYTES,
  SITE_CLAIM_PATH,
  addressSet,
  parseClaimDocument,
  sameAddressSet,
  siteClaimUrl,
  verifyWordpressSiteClaim,
};
