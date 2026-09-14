'use strict';
const { MAX_BYTES } = require('./whatsapp-inbox');
const { BrokerError, publicError } = require('./errors');

// Compose only with the dedicated TLS ingress route. This does not attach a
// listener, alter subscriptions or replace the closed legacy webhook by itself.
function createWhatsappInboxHandler({ inbox, withApplicationSecret }) {
  if (typeof inbox?.accept !== 'function' || typeof withApplicationSecret !== 'function') throw Error('invalid_request');
  return async (req, res) => {
    let raw; const chunks = [];
    const respond = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (status >= 500) res.setHeader('Retry-After', '60');
      res.statusCode = status; res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
      const signatures = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-hub-signature-256') signatures.push(req.rawHeaders[i + 1]);
      if (signatures.length !== 1 || !/^sha256=[a-f0-9]{64}$/.test(signatures[0])) return respond(401, { error: 'invalid_signature' });
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
        || !['', 'identity'].includes(String(req.headers['content-encoding'] || '').toLowerCase())) return respond(415, { error: 'unsupported_media_type' });
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) return respond(413, { error: 'payload_too_large' });
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks);
      const result = await withApplicationSecret(secret => inbox.accept({ raw, signature: signatures[0], appSecret: secret }));
      if (!result?.persisted || typeof result.receipt !== 'string') throw new BrokerError('audit_unavailable');
      return respond(200, { received: true });
    } catch (error) {
      const safe = publicError(error instanceof BrokerError ? error : new BrokerError('audit_unavailable'));
      return respond(safe.status, safe.body);
    } finally { raw?.fill(0); for (const chunk of chunks) chunk.fill(0); }
  };
}
module.exports = { createWhatsappInboxHandler };
