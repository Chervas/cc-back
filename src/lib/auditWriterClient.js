'use strict';
const https = require('node:https');
const protocol = require('../../services/platform-audit/src/writer-protocol');
function createClient({ origin, ca, keyId, privateKey, timeoutMs = 75000, agent = false }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.hash || base.search || !ca) protocol.fail();
  return {
    write(batch) {
      const { input, raw, headers } = protocol.signRequest(batch, { keyId, privateKey });
      return new Promise((resolve, reject) => {
        let timer;
        const unavailable = () => { clearTimeout(timer); reject(Object.assign(Error('audit_writer_unavailable'), { code: 'audit_writer_unavailable' })); };
        const request = https.request(new URL(protocol.PATH, base), { method: 'POST', ca: typeof ca === 'function' ? ca() : ca, rejectUnauthorized: true,
          minVersion: 'TLSv1.2', agent, headers }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 128000) request.destroy(); else chunks.push(chunk); });
          response.on('error', unavailable);
          response.on('end', () => {
            clearTimeout(timer);
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (response.statusCode !== 200) protocol.fail(protocol.safe({ code: value?.error }));
              resolve(protocol.resultFor(input, value).batch);
            } catch (error) { reject(Object.assign(Error(protocol.safe(error)), { code: protocol.safe(error) })); }
          });
        });
        timer = setTimeout(() => request.destroy(), Math.min(75000, Math.max(1, timeoutMs)));
        request.on('error', unavailable); request.end(raw);
      });
    },
  };
}
module.exports = { createClient };
