'use strict';

const crypto = require('node:crypto');
const Redis = require('ioredis');

const STATE_TTL_SECONDS = Math.max(60, Number(process.env.OAUTH_STATE_TTL_SECONDS) || 600);
const KEY_PREFIX = String(process.env.OAUTH_STATE_KEY_PREFIX || 'clinicaclick:oauth-state:v1').trim();
let redisClient = null;

function oauthStateError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  error.httpStatus = 400;
  return error;
}

function getRedisClient() {
  if (redisClient) return redisClient;
  redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redisClient.on('error', (error) => {
    console.error('❌ Redis OAuth state:', error.message);
  });
  return redisClient;
}

function stateKey(provider, token) {
  return `${KEY_PREFIX}:${provider}:${token}`;
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized !== 'google' && normalized !== 'meta') {
    throw oauthStateError('oauth_state_provider_invalid', 'Proveedor OAuth no válido.');
  }
  return normalized;
}

async function ensureConnected(store) {
  if (store.status === 'wait' && typeof store.connect === 'function') await store.connect();
}

async function issueOAuthState(payload, { store = getRedisClient(), ttlSeconds = STATE_TTL_SECONDS } = {}) {
  const provider = normalizeProvider(payload?.provider);
  const userId = Number.parseInt(String(payload?.userId ?? ''), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw oauthStateError('oauth_state_user_invalid', 'Usuario OAuth no válido.');
  }
  await ensureConnected(store);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomBytes(32).toString('base64url');
    const record = JSON.stringify({
      provider,
      userId,
      returnTo: payload.returnTo || null,
      clinicId: payload.clinicId || null,
      groupId: payload.groupId || null,
      assignmentScope: payload.assignmentScope || null,
      createdAt: new Date().toISOString(),
    });
    const result = await store.set(stateKey(provider, token), record, 'EX', ttlSeconds, 'NX');
    if (result === 'OK') return token;
  }
  throw new Error('No se pudo reservar un state OAuth único.');
}

async function atomicGetDelete(store, key) {
  if (typeof store.getdel === 'function') return store.getdel(key);
  return store.eval(
    "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
    1,
    key
  );
}

async function consumeOAuthState(providerInput, tokenInput, { store = getRedisClient() } = {}) {
  const provider = normalizeProvider(providerInput);
  const token = String(tokenInput || '').trim();
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
    throw oauthStateError('oauth_state_invalid', 'El state OAuth no es válido o ha caducado.');
  }
  await ensureConnected(store);
  const raw = await atomicGetDelete(store, stateKey(provider, token));
  if (!raw) {
    throw oauthStateError('oauth_state_invalid', 'El state OAuth no es válido, ha caducado o ya fue utilizado.');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    throw oauthStateError('oauth_state_invalid', 'El state OAuth almacenado no es válido.');
  }
  if (payload?.provider !== provider || !Number.isInteger(Number(payload?.userId))) {
    throw oauthStateError('oauth_state_invalid', 'El state OAuth no coincide con el proveedor solicitado.');
  }
  return payload;
}

module.exports = {
  STATE_TTL_SECONDS,
  consumeOAuthState,
  issueOAuthState,
};
