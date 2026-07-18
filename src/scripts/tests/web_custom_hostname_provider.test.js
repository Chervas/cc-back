'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  configuredProvider,
  ensureCustomHostname,
  normalizeProviderState,
} = require('../../services/webCustomHostnameProvider.service');

const env = {
  MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER: 'cloudflare',
  CLOUDFLARE_API_TOKEN: 'token-seguro-de-prueba-0123456789',
  MARKETING_WEB_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
  MARKETING_WEB_CLOUDFLARE_CUSTOM_ORIGIN: 'sites.clinicaclick.com',
};

function response(result) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify({ success: true, errors: [], messages: [], result }); },
  };
}

test('el proveedor es opt-in y falla cerrado si faltan secretos', () => {
  assert.equal(configuredProvider({}), null);
  assert.throws(
    () => configuredProvider({ MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER: 'cloudflare' }),
    (error) => error.code === 'web_custom_hostname_provider_not_configured'
  );
});

test('registra hostname SaaS tras buscar duplicados y no filtra el token', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return response([]);
    return response({
      id: 'b'.repeat(32),
      hostname: 'citas.clinica-example.es',
      status: 'pending',
      ssl: { status: 'pending_validation' },
      ownership_verification: { type: 'txt', name: '_acme.example', value: 'proof' },
    });
  };
  const state = await ensureCustomHostname({
    id: 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44',
    host: 'citas.clinica-example.es',
    tls: {},
  }, { env, fetchImpl });
  assert.equal(state.provider, 'cloudflare');
  assert.equal(state.ready, false);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.hostname, 'citas.clinica-example.es');
  assert.equal(body.ssl.method, 'http');
  assert.equal(body.custom_origin_server, 'sites.clinicaclick.com');
  assert.equal(JSON.stringify(state).includes(env.CLOUDFLARE_API_TOKEN), false);
  assert.equal(calls[1].options.body.includes(env.CLOUDFLARE_API_TOKEN), false);
  assert.match(calls[1].options.headers.authorization, /^Bearer /);
});

test('relee por id y solo marca listo con hostname y SSL activos', async () => {
  const result = {
    id: 'b'.repeat(32),
    hostname: 'citas.clinica-example.es',
    status: 'active',
    ssl: { status: 'active' },
  };
  assert.equal(normalizeProviderState(result, result.hostname).ready, true);
  const calls = [];
  const state = await ensureCustomHostname({
    id: 'domain-id',
    host: result.hostname,
    tls: { provider: { id: result.id } },
  }, {
    env,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return response(result); },
  });
  assert.equal(state.ready, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`${result.id}$`));
});
