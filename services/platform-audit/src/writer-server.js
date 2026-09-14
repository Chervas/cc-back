'use strict';
const https = require('node:https'); const { createPublicKey } = require('node:crypto');
const protocol = require('./writer-protocol'); const { sourceRole } = require('./batch');
function createServer({ store, principals, sourceRoleArn, write, now = Date.now }, tls) {
  sourceRole(sourceRoleArn);
  if (!tls?.key || !tls.cert || !Array.isArray(principals) || !principals.length) protocol.fail();
  const ids = new Set(); const publicKeys = new Set();
  for (const principal of principals) {
    if (typeof principal.keyId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(principal.keyId) || ids.has(principal.keyId)
      || typeof principal.enabled !== 'boolean') protocol.fail();
    const key = createPublicKey(principal.publicKey); const encoded = key.export({ type: 'spki', format: 'der' }).toString('base64');
    if (key.asymmetricKeyType !== 'ed25519' || publicKeys.has(encoded)) protocol.fail();
    ids.add(principal.keyId); publicKeys.add(encoded);
  }
  let active = 0;
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let admitted = false; let accepted = false; let input;
    try {
      if (active >= 4) protocol.fail('audit_writer_limited'); active++; admitted = true;
      if (req.method !== 'POST' || req.url !== protocol.PATH || req.headers['content-type'] !== 'application/json'
        || req.headers['content-encoding'] || req.headers['transfer-encoding']) protocol.fail();
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > protocol.MAX_BYTES) protocol.fail(); chunks.push(chunk); }
      const raw = Buffer.concat(chunks); input = protocol.inputFor(JSON.parse(raw.toString('utf8')));
      const principal = protocol.authenticate(raw, req.headers, input, principals, now());
      if (input.batch.sourceRoleArn !== sourceRoleArn) protocol.fail('audit_writer_denied');
      store.accept(principal.keyId, input, now()); accepted = true;
      const result = protocol.resultFor(input, { version: 1, requestId: input.requestId, batch: await write(input.batch) });
      store.finish(input, result.batch, now()); accepted = false;
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch (error) {
      // A transport error cannot turn an unknown S3 outcome into an acknowledgement.
      if (accepted) { try { store.finish(input, null, now()); } catch {} }
      const code = protocol.safe(error);
      const status = code === 'audit_writer_denied' ? 403 : code === 'audit_writer_invalid' ? 400
        : code === 'audit_writer_replayed' ? 409 : code === 'audit_writer_limited' ? 429 : 503;
      if (!res.headersSent) res.writeHead(status); res.end(JSON.stringify({ error: code }));
    } finally { if (admitted) active--; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.timeout = 80000;
  server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 30; return server;
}
module.exports = { createServer };
