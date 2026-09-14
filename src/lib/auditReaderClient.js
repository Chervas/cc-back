'use strict';
const https = require('node:https');
const { signRequest, resultFor, PATH, fail, safe } = require('../../services/platform-audit/src/reader-protocol');
function createClient({ origin, ca, keyId, privateKey, timeoutMs = 20000, agent = false }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.hash || base.search || !ca) fail();
  return {
    read(command) {
      const { input, raw, headers } = signRequest(command, { keyId, privateKey });
      return new Promise((resolve, reject) => {
        let timer; const request = https.request(new URL(PATH, base), { method: 'POST', ca, rejectUnauthorized: true,
          minVersion: 'TLSv1.2', agent, headers }, response => {
          const chunks = []; let size = 0;
          response.on('data', chunk => { size += chunk.length; if (size > 300000) request.destroy(); else chunks.push(chunk); });
          response.on('error', () => { clearTimeout(timer); reject(Object.assign(Error('audit_reader_unavailable'), { code: 'audit_reader_unavailable' })); });
          response.on('end', () => {
            clearTimeout(timer);
            try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (response.statusCode !== 200) fail(safe({ code: value?.error }));
              resolve(resultFor(input, value));
            } catch (error) { reject(Object.assign(Error(safe(error)), { code: safe(error) })); }
          });
        });
        timer = setTimeout(() => request.destroy(), Math.min(20000, Math.max(1, timeoutMs)));
        request.on('error', () => { clearTimeout(timer); reject(Object.assign(Error('audit_reader_unavailable'), { code: 'audit_reader_unavailable' })); });
        request.end(raw);
      });
    },
  };
}
module.exports = { createClient };
