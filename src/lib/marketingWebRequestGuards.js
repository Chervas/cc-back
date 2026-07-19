'use strict';

const crypto = require('node:crypto');
const Redis = require('ioredis');

const MARKETING_WEB_JSON_LIMIT_BYTES = 1024 * 1024;
const PUBLIC_RATE_LIMIT_PREFIX = String(
  process.env.MARKETING_WEB_RATE_LIMIT_PREFIX || 'clinicaclick:marketing-web-rate-limit:v1'
).trim();
const MAX_LOCAL_PUBLIC_RATE_LIMIT_BUCKETS = 10000;
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
  maxLocalBuckets = MAX_LOCAL_PUBLIC_RATE_LIMIT_BUCKETS,
} = {}) {
  if (!Number.isInteger(maxLocalBuckets) || maxLocalBuckets < 2) {
    throw new TypeError('public_marketing_web_local_bucket_limit_invalid');
  }
  const buckets = new Map();
  const distributedStore = store === undefined ? getPublicRateLimitRedis() : store;

  function pruneExpiredLocalBuckets(currentTime) {
    for (const [bucketKey, value] of buckets.entries()) {
      if (value.resetAt <= currentTime) buckets.delete(bucketKey);
    }
  }

  function localIncrement(key, limit, windowMs, currentTime) {
    const current = buckets.get(key);
    if (!current && buckets.size >= maxLocalBuckets) {
      pruneExpiredLocalBuckets(currentTime);
      // Si Redis no está disponible y el mapa local alcanza su cota con
      // buckets vivos, una identidad nueva se rechaza. Vaciar el mapa abriría
      // precisamente el bypass que este fallback debe contener.
      if (buckets.size >= maxLocalBuckets) {
        return {
          count: limit + 1,
          limit,
          retryAfter: Math.max(1, Math.ceil(windowMs / 1000)),
        };
      }
    }
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
    globalIpLimit,
  }) {
    if (!/^[a-z0-9][a-z0-9:_-]{1,95}$/i.test(String(operation || ''))) {
      throw new TypeError('public_marketing_web_rate_limit_operation_invalid');
    }
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new TypeError('public_marketing_web_rate_limit_invalid');
    }
    if (!Number.isInteger(windowMs) || windowMs <= 0) {
      throw new TypeError('public_marketing_web_rate_limit_window_invalid');
    }
    // Toda operación pública debe declarar un backstop global por IP mayor que
    // su bucket individual. Así se permiten varias instalaciones legítimas tras
    // una NAT, pero rotar UUID no permite consultas ilimitadas antes de auth.
    if (!Number.isInteger(globalIpLimit) || globalIpLimit <= limit) {
      throw new TypeError('public_marketing_web_global_ip_rate_limit_required');
    }
    return (req, res, next) => {
      const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 96);
      const currentTime = now();
      const globalKey = `${operation}:global-ip:${ip}`;

      function rejectRateLimit(bucket) {
        const retryAfter = bucket.retryAfter;
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
      }

      const run = async () => {
        // Este bucket se evalúa antes incluso de normalizar la identidad. Si la
        // IP ya agotó su cuota, no se crea una clave Redis distinta por cada
        // installationId válido o inválido que rote el atacante.
        const globalBucket = await distributedIncrement(
          globalKey,
          globalIpLimit,
          windowMs,
          currentTime
        );
        if (globalBucket.count > globalIpLimit) return rejectRateLimit(globalBucket);

        const suppliedIdentity = typeof identity === 'function'
          ? identity(req)
          : req.params?.installationId;
        const installationId = /^[a-f0-9-]{36}$/i.test(String(suppliedIdentity || ''))
          ? String(suppliedIdentity).toLowerCase()
          : 'invalid';
        const identityBucket = await distributedIncrement(
          `${operation}:${installationId}:${ip}`,
          limit,
          windowMs,
          currentTime
        );
        if (identityBucket.count > limit) return rejectRateLimit(identityBucket);
        return next();
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
