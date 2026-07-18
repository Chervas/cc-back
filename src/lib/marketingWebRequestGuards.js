'use strict';

const crypto = require('node:crypto');
const Redis = require('ioredis');

const MARKETING_WEB_JSON_LIMIT_BYTES = 1024 * 1024;
const PUBLIC_RATE_LIMIT_PREFIX = String(
  process.env.MARKETING_WEB_RATE_LIMIT_PREFIX || 'clinicaclick:marketing-web-rate-limit:v1'
).trim();
let publicRateLimitRedis = null;

function getPublicRateLimitRedis() {
  if (publicRateLimitRedis) return publicRateLimitRedis;
  publicRateLimitRedis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  publicRateLimitRedis.on('error', (error) => {
    console.error('❌ Redis marketing web rate limit:', error.message);
  });
  return publicRateLimitRedis;
}

async function ensureRedisConnected(store) {
  if (store?.status === 'wait' && typeof store.connect === 'function') await store.connect();
}

async function incrementDistributedBucket(store, key, windowMs) {
  await ensureRedisConnected(store);
  const result = await store.eval(
    [
      "local current = redis.call('INCR', KEYS[1])",
      "if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
      "local ttl = redis.call('PTTL', KEYS[1])",
      'return {current, ttl}',
    ].join('\n'),
    1,
    `${PUBLIC_RATE_LIMIT_PREFIX}:${crypto.createHash('sha256').update(key).digest('hex')}`,
    String(windowMs)
  );
  return {
    count: Number(result?.[0]) || 1,
    ttlMs: Math.max(1, Number(result?.[1]) || windowMs),
  };
}

function isMarketingWebJsonPath(pathname = '') {
  const normalized = String(pathname || '').split('?')[0];
  return normalized.startsWith('/api/marketing/web-projects')
    || normalized.startsWith('/api/marketing/web-revisions')
    || normalized.startsWith('/api/marketing/web-content')
    || normalized.startsWith('/api/marketing/web-media')
    || normalized.startsWith('/api/marketing/web-publications')
    || normalized.startsWith('/api/marketing/web-domains')
    || normalized.startsWith('/api/marketing/web-installations');
}

function createPublicMarketingWebRateLimiter({
  now = () => Date.now(),
  // `false` mantiene un almacén local determinista para tests. En ejecución
  // real Redis hace que el límite sea único aunque PM2 tenga varios workers.
  store = undefined,
} = {}) {
  const buckets = new Map();
  const distributedStore = store === undefined ? getPublicRateLimitRedis() : store;

  function localIncrement(key, limit, windowMs, currentTime) {
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= currentTime
      ? { count: 0, resetAt: currentTime + windowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    return {
      count: bucket.count,
      limit,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000)),
    };
  }

  async function distributedIncrement(key, limit, windowMs, currentTime) {
    if (!distributedStore) return localIncrement(key, limit, windowMs, currentTime);
    try {
      const bucket = await incrementDistributedBucket(distributedStore, key, windowMs);
      return {
        count: bucket.count,
        limit,
        retryAfter: Math.max(1, Math.ceil(bucket.ttlMs / 1000)),
      };
    } catch (error) {
      // Una caída de Redis no debe tumbar formularios ni el control plane del
      // plugin. Se degrada al bucket local y se conserva la defensa por proceso.
      console.error('⚠️ Rate limit marketing web degradado a memoria:', error.message);
      return localIncrement(key, limit, windowMs, currentTime);
    }
  }

  return function publicMarketingWebRateLimiter({
    operation,
    limit,
    windowMs,
    identity = null,
    globalIpLimit = null,
  }) {
    return (req, res, next) => {
      const suppliedIdentity = typeof identity === 'function'
        ? identity(req)
        : req.params?.installationId;
      const installationId = /^[a-f0-9-]{36}$/i.test(String(suppliedIdentity || ''))
        ? String(suppliedIdentity).toLowerCase()
        : 'invalid';
      const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 96);
      const currentTime = now();
      const identities = [{ key: `${operation}:${installationId}:${ip}`, limit }];
      if (Number.isInteger(globalIpLimit) && globalIpLimit > limit) {
        identities.push({ key: `${operation}:global-ip:${ip}`, limit: globalIpLimit });
      }
      const run = async () => {
        let exceeded = null;
        for (const item of identities) {
          const bucket = await distributedIncrement(item.key, item.limit, windowMs, currentTime);
          if (!exceeded && bucket.count > item.limit) exceeded = bucket;
        }
        if (buckets.size > 10000) {
          for (const [bucketKey, value] of buckets.entries()) {
            if (value.resetAt <= currentTime) buckets.delete(bucketKey);
          }
          if (buckets.size > 10000) buckets.clear();
        }
        if (!exceeded) return next();
        const retryAfter = exceeded.retryAfter;
        const requestId = crypto.randomUUID();
        res.set('Retry-After', String(retryAfter));
        res.set('X-Request-Id', requestId);
        res.set('Cache-Control', 'no-store');
        return res.status(429).json({
          success: false,
          error: {
            code: 'rate_limit_exceeded',
            message: 'Este sitio ha realizado demasiadas solicitudes. Espera antes de reintentar.',
            details: { operation, retry_after_seconds: retryAfter },
          },
          request_id: requestId,
        });
      };
      return run().catch(next);
    };
  };
}

function assertMarketingWebJsonBodySize(req, buffer, limitBytes = MARKETING_WEB_JSON_LIMIT_BYTES) {
  if (!isMarketingWebJsonPath(req?.originalUrl || req?.url || req?.path)) return true;
  if (!Buffer.isBuffer(buffer) || buffer.length <= limitBytes) return true;
  const error = new Error('El documento supera el límite de 1 MB permitido por el editor web.');
  error.type = 'entity.too.large';
  error.code = 'marketing_web_payload_too_large';
  error.status = 413;
  error.statusCode = 413;
  error.limit = limitBytes;
  error.length = buffer.length;
  throw error;
}

function invalidMarketingWebJsonResponse(error, pathname = '') {
  const normalizedPath = String(pathname || '').split('?')[0];
  const guardedPath = isMarketingWebJsonPath(normalizedPath)
    || normalizedPath === '/api/public-media/upload';
  const malformedJson = guardedPath
    && error instanceof SyntaxError
    && Number(error?.status || error?.statusCode) === 400
    && Object.prototype.hasOwnProperty.call(error, 'body');
  if (!malformedJson) return null;
  return {
    success: false,
    error: {
      code: 'marketing_web_invalid_json',
      message: 'El cuerpo JSON no es válido.',
    },
  };
}

function createMarketingWebRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  return function marketingWebRateLimiter({ operation, limit, windowMs }) {
    return (req, res, next) => {
      const actorId = Number(req.userData?.userId);
      if (!Number.isSafeInteger(actorId) || actorId <= 0) return next();
      const key = `${operation}:${actorId}`;
      const currentTime = now();
      const current = buckets.get(key);
      const bucket = !current || current.resetAt <= currentTime
        ? { count: 0, resetAt: currentTime + windowMs }
        : current;
      bucket.count += 1;
      buckets.set(key, bucket);
      if (buckets.size > 10000) {
        for (const [bucketKey, value] of buckets.entries()) {
          if (value.resetAt <= currentTime) buckets.delete(bucketKey);
        }
      }
      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
      res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
      if (bucket.count <= limit) return next();
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000));
      const suppliedRequestId = String(req.get?.('X-Request-Id') || '').trim();
      const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : crypto.randomUUID();
      res.set('Retry-After', String(retryAfter));
      res.set('X-Request-Id', requestId);
      res.set('Cache-Control', 'no-store');
      return res.status(429).json({
        success: false,
        error: {
          code: 'rate_limit_exceeded',
          message: 'Has realizado demasiadas operaciones seguidas. Espera unos segundos y vuelve a intentarlo.',
          details: { operation, retry_after_seconds: retryAfter },
        },
        request_id: requestId,
      });
    };
  };
}

module.exports = {
  MARKETING_WEB_JSON_LIMIT_BYTES,
  assertMarketingWebJsonBodySize,
  createMarketingWebRateLimiter,
  createPublicMarketingWebRateLimiter,
  invalidMarketingWebJsonResponse,
  isMarketingWebJsonPath,
};
