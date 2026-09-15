'use strict';
const { clientFiles, createInboxClient } = require('./whatsappInboxClient');
const MAX = 3 * 1024 * 1024;
function createGatewayHandler(client) {
  let running = 0;
  return async (req, res) => {
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
      if (status >= 500 || status === 429) res.setHeader('Retry-After', '60');
      res.statusCode = status; res.end(JSON.stringify(body));
    };
    let raw; const parts = []; let occupied = false;
    try {
      if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      if (!client) return reply(503, { error: 'whatsapp_ingress_unavailable' });
      if (running >= 8) return reply(503, { error: 'whatsapp_ingress_unavailable' });
      running++; occupied = true;
      const signatures = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-hub-signature-256') signatures.push(req.rawHeaders[i+1]);
      if (signatures.length !== 1 || !/^sha256=[a-f0-9]{64}$/.test(signatures[0])) return reply(401, { error: 'invalid_signature' });
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
        || !['', 'identity'].includes(String(req.headers['content-encoding'] || '').toLowerCase())) return reply(415, { error: 'unsupported_media_type' });
      req.setTimeout(10000, () => req.destroy());
      let length = 0;
      for await (const part of req) { length += part.length; if (length > MAX) return reply(413, { error: 'payload_too_large' }); parts.push(part); }
      raw = Buffer.concat(parts);
      const result = await client.request('POST', '', raw, { 'x-hub-signature-256': signatures[0] });
      if (result.status === 200 && result.data?.received === true) return reply(200, { received: true });
      const status = [400,401,403,413,415,429].includes(result.status) ? result.status : 503;
      return reply(status, { error: status === 503 ? 'whatsapp_ingress_unavailable' : 'whatsapp_ingress_rejected' });
    } catch { return reply(503, { error: 'whatsapp_ingress_unavailable' }); }
    finally { raw?.fill(0); for (const p of parts) p.fill(0); if (occupied) running--; }
  };
}
function gatewayMiddleware(env = process.env) {
  // Default stays closed, including DEV and any copied configuration.
  const client = env.WHATSAPP_INBOX_GATEWAY_ENABLED === 'true' ? createInboxClient(clientFiles(env, 'gateway')) : null;
  const handle = createGatewayHandler(client);
  return (req, res, next) => req.method === 'POST' && /^\/api\/whatsapp\/webhook\/?(?:\?.*)?$/.test(req.originalUrl || req.url)
    ? handle(req, res) : next();
}
module.exports = { createGatewayHandler, gatewayMiddleware };
