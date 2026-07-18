'use strict';

const crypto = require('node:crypto');

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INVALID_PREPARE_IDENTITY = '00000000-0000-4000-8000-000000000000';
const PREPARE_LIMIT = 1200;
const PREPARE_GLOBAL_IP_LIMIT = 10000;
const CANONICAL_PUBLICATION_LIMIT = 1000;

function digestAsUuid(value) {
  const digest = crypto.createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

// Esta identidad solo particiona la barrera barata anterior a BD. No concede
// confianza: prepare vuelve a resolver revisión, página, host, path, artefacto
// y publicación activa. Al incluir la ruta pública, varias landings alojadas
// tras una misma IP de WordPress no consumen el mismo bucket preliminar.
function landingEventBridgePrepareIdentity(req) {
  const body = req?.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const identity = ['web_project_id', 'web_revision_id', 'web_page_id']
    .map((field) => String(body[field] || '').trim().toLowerCase());
  if (identity.some((value) => !UUID_V4.test(value))) return INVALID_PREPARE_IDENTITY;
  try {
    const referer = new URL(String(req?.headers?.referer || '').trim());
    if (referer.protocol !== 'https:' || referer.username || referer.password) {
      return INVALID_PREPARE_IDENTITY;
    }
    return digestAsUuid(`${identity.join('|')}|${referer.origin.toLowerCase()}|${referer.pathname}`);
  } catch {
    return INVALID_PREPARE_IDENTITY;
  }
}

function canonicalPublicationIdentity(req) {
  return req.webLandingRateLimitIdentity;
}

function landingEventBridgeRateLimitOptions() {
  return {
    preliminary: {
      operation: 'landing_event_bridge_prepare',
      // Debe quedar por encima del límite canónico: una publicación válida
      // siempre se gobierna por el bucket resuelto después de prepare.
      limit: PREPARE_LIMIT,
      windowMs: 10 * 60 * 1000,
      identity: landingEventBridgePrepareIdentity,
      // Impide el bypass por rotación de UUID/ruta sin volver a agregar todas
      // las landings legítimas de un hosting WordPress compartido a 300 eventos.
      globalIpLimit: PREPARE_GLOBAL_IP_LIMIT,
    },
    canonical: {
      operation: 'landing_event_bridge',
      limit: CANONICAL_PUBLICATION_LIMIT,
      windowMs: 10 * 60 * 1000,
      identity: canonicalPublicationIdentity,
    },
  };
}

module.exports = {
  CANONICAL_PUBLICATION_LIMIT,
  INVALID_PREPARE_IDENTITY,
  PREPARE_GLOBAL_IP_LIMIT,
  PREPARE_LIMIT,
  canonicalPublicationIdentity,
  landingEventBridgePrepareIdentity,
  landingEventBridgeRateLimitOptions,
};
