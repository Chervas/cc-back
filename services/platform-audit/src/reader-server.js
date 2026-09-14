'use strict';
const https = require('node:https');
const { createPublicKey } = require('node:crypto');
const { PATH, inputFor, resultFor, authenticate, fail, safe } = require('./reader-protocol');
function createServer({ store, principals, read, now = Date.now }, tls) {
  if (!tls?.key || !tls.cert || !Array.isArray(principals) || !principals.length) fail();
  const ids = new Set(); const publicKeys = new Set();
  for (const p of principals) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(p.keyId) || ids.has(p.keyId) || typeof p.enabled !== 'boolean'
      || !Array.isArray(p.modes) || p.modes.length !== 1 || !['confirmed', 'reconcile'].includes(p.modes[0])) fail();
    const key = createPublicKey(p.publicKey); const encoded = key.export({ type: 'spki', format: 'der' }).toString('base64');
    if (key.asymmetricKeyType !== 'ed25519' || publicKeys.has(encoded)) fail();
    ids.add(p.keyId); publicKeys.add(encoded);
  }
  let active = 0;
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Content-Type-Options', 'nosniff');
    let admitted = false;
    try {
      if (active >= 4) fail('audit_reader_limited'); active++; admitted = true;
      if (req.method !== 'POST' || req.url !== PATH || req.headers['content-type'] !== 'application/json'
        || req.headers['content-encoding'] || req.headers['transfer-encoding']) fail();
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) fail(); chunks.push(chunk); }
      const raw = Buffer.concat(chunks); const input = inputFor(JSON.parse(raw.toString('utf8')));
      const principal = authenticate(raw, req.headers, input, principals, now());
      store.accept(principal.keyId, input, now());
      const result = resultFor(input, await read(input));
      store.complete(input, result, now());
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch (error) {
      const code = safe(error); const status = code === 'audit_reader_denied' ? 403 : code === 'audit_reader_invalid' ? 400
        : code === 'audit_reader_replayed' ? 409 : code === 'audit_reader_limited' ? 429 : 503;
      if (!res.headersSent) res.writeHead(status); res.end(JSON.stringify({ error: code }));
    } finally { if (admitted) active--; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.timeout = 20000;
  server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 30; return server;
}
module.exports = { createServer };
