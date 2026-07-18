'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  DNS_TOKEN_PREFIX,
  inspectDns,
  inspectTls,
  normalizeCustomHost,
} = require('../../services/webDomains.service');

test('normaliza dominios públicos y rechaza infraestructura reservada', () => {
  assert.equal(normalizeCustomHost('Landing.Clinica-Example.es.'), 'landing.clinica-example.es');
  assert.throws(
    () => normalizeCustomHost('sites.clinicaclick.com'),
    (error) => error.code === 'web_domain_host_reserved'
  );
  assert.throws(
    () => normalizeCustomHost('127.0.0.1'),
    (error) => error.code === 'web_domain_host_invalid'
  );
});

test('verifica propiedad TXT y routing CNAME sin conservar el token observado', async () => {
  const token = 'token-publico-de-verificacion';
  const txtValue = `${DNS_TOKEN_PREFIX}${token}`;
  const domain = {
    host: 'citas.clinica-example.es',
    ownershipTokenHash: crypto.createHash('sha256').update(txtValue).digest('hex'),
    expectedDns: {
      ownership: { name: '_clinicaclick-verify.citas.clinica-example.es' },
      routing: { target: 'sites.clinicaclick.com' },
    },
  };
  const resolver = {
    async resolveTxt(name) {
      assert.equal(name, domain.expectedDns.ownership.name);
      return [[txtValue.slice(0, 20), txtValue.slice(20)]];
    },
    async resolveCname(name) {
      assert.equal(name, domain.host);
      return ['sites.clinicaclick.com.'];
    },
    async resolve4() { return []; },
    async resolve6() { return []; },
  };
  const result = await inspectDns({ domain, resolver });
  assert.equal(result.ownership_verified, true);
  assert.equal(result.routing_verified, true);
  assert.deepEqual(result.observed_cnames, ['sites.clinicaclick.com']);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('acepta ALIAS/flattening solo si comparte una IP real con el origen', async () => {
  const txtValue = `${DNS_TOKEN_PREFIX}token`;
  const domain = {
    host: 'clinica-example.es',
    ownershipTokenHash: crypto.createHash('sha256').update(txtValue).digest('hex'),
    expectedDns: {
      ownership: { name: '_clinicaclick-verify.clinica-example.es' },
      routing: { target: 'sites.clinicaclick.com' },
    },
  };
  const resolver = {
    async resolveTxt() { return [[txtValue]]; },
    async resolveCname() { return []; },
    async resolve4(name) { return name === domain.host ? ['203.0.113.10'] : ['203.0.113.10', '203.0.113.11']; },
    async resolve6() { return []; },
  };
  const result = await inspectDns({ domain, resolver });
  assert.equal(result.routing_verified, true);
  assert.equal(result.routed_by_address_match, true);
});

test('fija la IP pública validada durante el handshake TLS para impedir DNS rebind', async () => {
  let connectOptions;
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.authorized = true;
    }

    setTimeout() {}
    destroy() {}
    getProtocol() { return 'TLSv1.3'; }
    getPeerCertificate() { return { valid_to: 'Jan 01 00:00:00 2030 GMT' }; }
  }
  const socket = new FakeSocket();
  const probe = inspectTls('citas.clinica-example.es', {
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    tlsConnect(options) {
      connectOptions = options;
      process.nextTick(() => socket.emit('secureConnect'));
      return socket;
    },
  });
  const result = await probe;
  assert.equal(result.ready, true);
  assert.equal(connectOptions.servername, 'citas.clinica-example.es');
  assert.equal(connectOptions.rejectUnauthorized, true);
  const pinned = await new Promise((resolve, reject) => {
    connectOptions.lookup('citas.clinica-example.es', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
  await assert.rejects(
    new Promise((resolve, reject) => {
      connectOptions.lookup('localhost', {}, (error) => (error ? reject(error) : resolve()));
    }),
    (error) => error.code === 'PINNED_HOST_MISMATCH'
  );
});

test('no abre TLS cuando el dominio resuelve a una dirección no pública', async () => {
  let connected = false;
  const result = await inspectTls('citas.clinica-example.es', {
    resolveAddresses: async () => {
      const error = new Error('unsafe');
      error.code = 'UNSAFE_TARGET_ADDRESS';
      throw error;
    },
    tlsConnect() {
      connected = true;
      throw new Error('must not connect');
    },
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'UNSAFE_TARGET_ADDRESS');
  assert.equal(connected, false);
});
