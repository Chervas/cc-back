'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const tls = require('node:tls');
const { Op } = require('sequelize');
const db = require('../../models');
const { assertWebPublishingEnabled } = require('../lib/marketingWebFeatureFlags');
const {
  assertScopeAccess,
  normalizeScope,
  positiveInteger,
  scopeColumns,
} = require('./webProjects.service');
const { normalizeHost } = require('./webHostedPublisher.service');
const { WebPublicationServiceError } = require('./webPublications.service');
const { ensureCustomHostname } = require('./webCustomHostnameProvider.service');
const { createPinnedLookup, resolvePublicAddresses } = require('../lib/safeHttpTarget');

const DNS_TOKEN_PREFIX = 'clinicaclick-verification=';
const DEFAULT_CNAME_TARGET = 'sites.clinicaclick.com';
const DEFAULT_RECONCILIATION_LIMIT = 25;
const DOMAIN_RECHECK_MS = Object.freeze({
  pending_dns: 15 * 60 * 1000,
  pending_tls: 15 * 60 * 1000,
  failed: 6 * 60 * 60 * 1000,
  ready: 24 * 60 * 60 * 1000,
});

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function scopeWhere(scope) {
  return scope.type === 'clinic'
    ? { scopeType: 'clinic', clinicaId: scope.id }
    : { scopeType: 'group', grupoClinicaId: scope.id };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeHashEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeCustomHost(value, env = process.env) {
  let host;
  try {
    host = normalizeHost(value);
  } catch {
    throw new WebPublicationServiceError('web_domain_host_invalid', 'El dominio no es válido.', 422);
  }
  const reserved = normalizeHost(env.MARKETING_WEB_HOSTED_DOMAIN || DEFAULT_CNAME_TARGET);
  if (host === reserved || host.endsWith(`.${reserved}`) || host.endsWith('.clinicaclick.com')) {
    throw new WebPublicationServiceError(
      'web_domain_host_reserved',
      'Ese dominio está reservado para la infraestructura de ClinicaClick.',
      422
    );
  }
  return host;
}

function normalizeCommercialMode(value) {
  const mode = String(value || 'paid_domain').trim().toLowerCase();
  if (!['included', 'paid_domain'].includes(mode)) {
    throw new WebPublicationServiceError('web_domain_commercial_mode_invalid', 'La modalidad del dominio no es válida.', 422);
  }
  return mode;
}

function serializeDomain(row) {
  const value = plain(row);
  return {
    id: value.id,
    scope: {
      type: value.scopeType,
      id: Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId),
    },
    host: value.host,
    kind: value.kind,
    status: value.status,
    expected_dns: value.expectedDns || {},
    verification: value.verification || {},
    tls: value.tls || {},
    commercial_mode: value.commercialMode,
    version: Number(value.version),
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function verificationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function expectedDnsFor(host, env = process.env) {
  return {
    ownership: {
      type: 'TXT',
      name: `_clinicaclick-verify.${host}`,
      value_format: `${DNS_TOKEN_PREFIX}<token>`,
    },
    routing: {
      type: 'CNAME_OR_ALIAS',
      name: host,
      target: normalizeHost(env.MARKETING_WEB_CUSTOM_DOMAIN_TARGET || env.MARKETING_WEB_HOSTED_DOMAIN || DEFAULT_CNAME_TARGET),
    },
  };
}

async function createDomain({
  actorId,
  body = {},
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  assertAccess = assertScopeAccess,
  assertPublishing = assertWebPublishingEnabled,
} = {}) {
  const scope = normalizeScope(body);
  await assertAccess(actorId, scope, 'marketing.web.domains.manage', { models });
  assertPublishing(scope);
  const host = normalizeCustomHost(body.host, env);
  const token = verificationToken();
  const expectedDns = expectedDnsFor(host, env);
  try {
    const row = await sequelize.transaction(async (transaction) => {
      const domain = await models.WebDomain.create({
        id: crypto.randomUUID(),
        ...scopeColumns(scope),
        host,
        kind: 'custom_domain',
        status: 'pending_dns',
        ownershipTokenHash: sha256(`${DNS_TOKEN_PREFIX}${token}`),
        expectedDns,
        verification: {},
        tls: {},
        commercialMode: normalizeCommercialMode(body.commercial_mode),
        version: 1,
        createdByUserId: positiveInteger(actorId),
        updatedByUserId: positiveInteger(actorId),
      }, { transaction });
      await models.WebAuditEvent.create({
        projectId: null,
        ...scopeColumns(scope),
        actorUserId: positiveInteger(actorId),
        eventType: 'web.domain.created',
        entityType: 'web_domain',
        entityId: domain.id,
        requestId,
        metadata: { host_hash: sha256(host), commercial_mode: domain.commercialMode },
      }, { transaction });
      return domain;
    });
    return {
      domain: serializeDomain(row),
      verification_token: token,
      dns_instructions: {
        txt: { name: expectedDns.ownership.name, value: `${DNS_TOKEN_PREFIX}${token}` },
        routing: expectedDns.routing,
      },
    };
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      throw new WebPublicationServiceError('web_domain_host_in_use', 'Ese dominio ya está registrado.', 409);
    }
    throw error;
  }
}

async function listDomains({
  actorId,
  query = {},
  models = db,
  assertAccess = assertScopeAccess,
} = {}) {
  const scope = normalizeScope(query);
  await assertAccess(actorId, scope, 'marketing.web.view', { models });
  const rows = await models.WebDomain.findAll({
    where: {
      ...scopeWhere(scope),
      ...(query.include_retired === 'true' ? {} : { status: { [Op.ne]: 'retired' } }),
    },
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit: 100,
  });
  return rows.map(serializeDomain);
}

async function getDomainForActor({ actorId, domainId, models = db, assertAccess = assertScopeAccess } = {}) {
  const domain = await models.WebDomain.findByPk(String(domainId || ''));
  if (!domain) throw new WebPublicationServiceError('web_domain_not_found', 'El dominio no existe.', 404);
  const value = plain(domain);
  const scope = value.scopeType === 'clinic'
    ? { type: 'clinic', id: Number(value.clinicaId) }
    : { type: 'group', id: Number(value.grupoClinicaId) };
  try {
    await assertAccess(actorId, scope, 'marketing.web.domains.manage', { models });
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebPublicationServiceError('web_domain_not_found', 'El dominio no existe.', 404);
    }
    throw error;
  }
  return { domain, scope };
}

function flattenTxt(records) {
  return (Array.isArray(records) ? records : [])
    .filter(Array.isArray)
    .map((parts) => parts.map((part) => String(part)).join(''))
    .filter((value) => value.length <= 1024);
}

async function resolveSafe(resolver, method, host) {
  try {
    const result = await resolver[method](host);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    if (['ENODATA', 'ENOTFOUND', 'ESERVFAIL', 'ETIMEOUT', 'EREFUSED'].includes(error?.code)) return [];
    throw error;
  }
}

async function inspectDns({ domain, resolver = dns }) {
  const value = plain(domain);
  const expected = value.expectedDns || {};
  const txtValues = flattenTxt(await resolveSafe(resolver, 'resolveTxt', expected.ownership?.name));
  const ownershipVerified = txtValues.some((entry) => safeHashEquals(sha256(entry), value.ownershipTokenHash));
  const expectedTarget = normalizeHost(expected.routing?.target || DEFAULT_CNAME_TARGET);
  const cnames = (await resolveSafe(resolver, 'resolveCname', value.host))
    .map((entry) => {
      try { return normalizeHost(entry); } catch { return null; }
    })
    .filter(Boolean);
  let routingVerified = cnames.includes(expectedTarget);
  let addressMatch = false;
  if (!routingVerified) {
    const [host4, host6, target4, target6] = await Promise.all([
      resolveSafe(resolver, 'resolve4', value.host),
      resolveSafe(resolver, 'resolve6', value.host),
      resolveSafe(resolver, 'resolve4', expectedTarget),
      resolveSafe(resolver, 'resolve6', expectedTarget),
    ]);
    const targetAddresses = new Set([...target4, ...target6].map(String));
    addressMatch = [...host4, ...host6].some((address) => targetAddresses.has(String(address)));
    routingVerified = addressMatch && targetAddresses.size > 0;
  }
  return {
    ownership_verified: ownershipVerified,
    routing_verified: routingVerified,
    observed_cnames: cnames.slice(0, 10),
    routed_by_address_match: addressMatch,
  };
}

async function inspectTls(host, {
  timeoutMs = 8000,
  lookup = dns.lookup,
  resolveAddresses = resolvePublicAddresses,
  tlsConnect = tls.connect,
} = {}) {
  let addresses;
  let pinnedLookup;
  try {
    addresses = await resolveAddresses(host, { lookup });
    pinnedLookup = createPinnedLookup(host, addresses);
  } catch (error) {
    return {
      ready: false,
      reason: String(error?.code || 'tls_target_unsafe').slice(0, 64),
    };
  }
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(result);
    };
    const validUntil = (value) => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    };
    try {
      socket = tlsConnect({
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: true,
        lookup: pinnedLookup,
      });
    } catch (error) {
      finish({ ready: false, reason: String(error?.code || 'tls_error').slice(0, 64) });
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      finish({
        ready: socket.authorized === true,
        authorized: socket.authorized === true,
        protocol: socket.getProtocol() || null,
        valid_until: validUntil(certificate?.valid_to),
      });
    });
    socket.once('timeout', () => finish({ ready: false, reason: 'timeout' }));
    socket.once('error', (error) => finish({ ready: false, reason: String(error?.code || 'tls_error').slice(0, 64) }));
  });
}

async function verifyDomain({
  actorId,
  domainId,
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertScopeAccess,
  resolver = dns,
  tlsInspector = inspectTls,
  hostnameProvider = ensureCustomHostname,
  env = process.env,
} = {}) {
  const { domain, scope } = await getDomainForActor({ actorId, domainId, models, assertAccess });
  if (domain.status === 'retired') {
    throw new WebPublicationServiceError('web_domain_retired', 'El dominio está retirado.', 409);
  }
  const dnsResult = await inspectDns({ domain, resolver });
  let tlsResult = { ready: false, reason: 'dns_pending' };
  if (dnsResult.ownership_verified && dnsResult.routing_verified) {
    let provider = null;
    try {
      provider = await hostnameProvider(domain, { env });
    } catch (error) {
      if (!(error instanceof WebPublicationServiceError)) throw error;
      provider = {
        provider: 'cloudflare',
        ready: false,
        error_code: error.code,
        checked_at: new Date().toISOString(),
      };
    }
    if (provider) {
      const probe = provider.ready ? await tlsInspector(domain.host) : { ready: false, reason: 'provider_pending' };
      tlsResult = {
        ready: provider.ready === true && probe.ready === true,
        reason: provider.ready === true && probe.ready !== true
          ? String(probe.reason || 'tls_probe_pending')
          : provider.ready === true
            ? null
            : String(provider.error_code || 'provider_pending'),
        provider,
        origin_probe: probe,
        valid_until: probe.valid_until || null,
        protocol: probe.protocol || null,
      };
    } else {
      tlsResult = await tlsInspector(domain.host);
    }
  }
  const status = !dnsResult.ownership_verified || !dnsResult.routing_verified
    ? 'pending_dns'
    : tlsResult.ready
      ? 'ready'
      : 'pending_tls';
  const checkedAt = new Date().toISOString();
  const updated = await sequelize.transaction(async (transaction) => {
    const locked = await models.WebDomain.findByPk(domain.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.status === 'retired') {
      throw new WebPublicationServiceError('web_domain_not_found', 'El dominio no existe.', 404);
    }
    await locked.update({
      status,
      verification: { ...dnsResult, checked_at: checkedAt },
      tls: { ...tlsResult, checked_at: checkedAt },
      version: Number(locked.version) + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await models.WebAuditEvent.create({
      projectId: null,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.domain.verified',
      entityType: 'web_domain',
      entityId: locked.id,
      requestId,
      metadata: {
        status,
        ownership_verified: dnsResult.ownership_verified,
        routing_verified: dnsResult.routing_verified,
        tls_ready: tlsResult.ready === true,
      },
    }, { transaction });
    return locked;
  });
  return serializeDomain(updated);
}

function domainLastCheckedAt(row) {
  const value = plain(row) || {};
  for (const candidate of [value.verification?.checked_at, value.tls?.checked_at, value.updated_at]) {
    const timestamp = Date.parse(candidate || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function domainDueForReconciliation(row, nowMs = Date.now()) {
  const value = plain(row) || {};
  const cadence = DOMAIN_RECHECK_MS[value.status];
  if (!cadence || value.status === 'retired') return false;
  return nowMs - domainLastCheckedAt(value) >= cadence;
}

async function reconcileDomains({
  jobRequestId = null,
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  resolver = dns,
  tlsInspector = inspectTls,
  hostnameProvider = ensureCustomHostname,
  verify = verifyDomain,
  now = new Date(),
  limit = DEFAULT_RECONCILIATION_LIMIT,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new WebPublicationServiceError('web_domain_reconciliation_time_invalid', 'La fecha de reconciliación no es válida.', 500);
  }
  const boundedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_RECONCILIATION_LIMIT), 100);
  const candidates = await models.WebDomain.findAll({
    where: { status: { [Op.in]: Object.keys(DOMAIN_RECHECK_MS) } },
    order: [['updated_at', 'ASC'], ['id', 'ASC']],
    limit: Math.min(boundedLimit * 4, 400),
  });
  const due = candidates
    .filter((row) => domainDueForReconciliation(row, nowMs))
    .slice(0, boundedLimit);
  const outcomes = [];
  const errors = [];
  for (const row of due) {
    const value = plain(row);
    try {
      const domain = await verify({
        actorId: null,
        domainId: value.id,
        requestId: jobRequestId ? `job:${jobRequestId}:domain:${value.id}` : null,
        models,
        sequelize,
        // Bypass exclusivamente interno. La ruta pública conserva el permiso
        // marketing.web.domains.manage y el ocultamiento 404 por scope.
        assertAccess: async () => true,
        resolver,
        tlsInspector,
        hostnameProvider,
        env,
      });
      outcomes.push({ domain_id: value.id, previous_status: value.status, status: domain.status });
    } catch (error) {
      errors.push({
        domain_id: value.id,
        code: String(error?.code || 'web_domain_reconciliation_failed').slice(0, 96),
        status: Number(error?.status || 500),
      });
    }
  }
  const retryable = errors.some((item) => item.status >= 500);
  return {
    status: retryable ? 'failed' : 'completed',
    retryable,
    considered: candidates.length,
    due: due.length,
    processed: outcomes.length,
    errors,
    outcomes,
  };
}

async function rotateDomainToken({
  actorId,
  domainId,
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertScopeAccess,
} = {}) {
  const { domain, scope } = await getDomainForActor({ actorId, domainId, models, assertAccess });
  const token = verificationToken();
  const updated = await sequelize.transaction(async (transaction) => {
    const locked = await models.WebDomain.findByPk(domain.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.status === 'retired') {
      throw new WebPublicationServiceError('web_domain_not_found', 'El dominio no existe.', 404);
    }
    await locked.update({
      ownershipTokenHash: sha256(`${DNS_TOKEN_PREFIX}${token}`),
      status: 'pending_dns',
      verification: {},
      tls: {},
      version: Number(locked.version) + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await models.WebAuditEvent.create({
      projectId: null,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.domain.verification_rotated',
      entityType: 'web_domain',
      entityId: locked.id,
      requestId,
      metadata: {},
    }, { transaction });
    return locked;
  });
  return {
    domain: serializeDomain(updated),
    verification_token: token,
    dns_instructions: {
      txt: {
        name: updated.expectedDns.ownership.name,
        value: `${DNS_TOKEN_PREFIX}${token}`,
      },
      routing: updated.expectedDns.routing,
    },
  };
}

module.exports = {
  DEFAULT_CNAME_TARGET,
  DNS_TOKEN_PREFIX,
  createDomain,
  expectedDnsFor,
  flattenTxt,
  getDomainForActor,
  inspectDns,
  inspectTls,
  listDomains,
  domainDueForReconciliation,
  normalizeCustomHost,
  reconcileDomains,
  rotateDomainToken,
  serializeDomain,
  verifyDomain,
};
