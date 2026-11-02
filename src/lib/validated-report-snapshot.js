'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

// The cache stores data, never authority. Capture checks live assignments and
// committed source revisions. HTTP callers still validate their session and
// permissions around this entire operation; workers use the same data identity.
async function prepareValidatedReportSnapshot({ capture, buildIdentity, generate, cache }) {
  const contextKey = digest(await capture());
  const identity = buildIdentity(contextKey);
  const validate = async () => {
    if (digest(await capture()) !== contextKey) {
      throw Object.assign(Error('sc_analytics_configuration_changed'), { code: 'sc_analytics_configuration_changed', status: 409 });
    }
  };
  const guardedGenerate = async () => {
    const payload = await generate();
    await validate(); // Do not persist a snapshot built across revisions/mappings.
    return payload;
  };
  return {
    identity,
    generate: guardedGenerate,
    validate,
    async read(options = {}) {
      const result = cache
        ? await cache.readOrGenerate({ ...options, identity, generate: guardedGenerate })
        : await guardedGenerate();
      await validate(); // Includes cache hits, stale responses and lease races.
      return result;
    },
  };
}

module.exports = { prepareValidatedReportSnapshot, digest };
