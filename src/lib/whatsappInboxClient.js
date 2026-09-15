'use strict';
const https = require('node:https'); const fs = require('node:fs');
function clientFiles(env, role) {
  if (!['gateway', 'staging'].includes(role) || env.RUNTIME_NAMESPACE !== role
    || env.WHATSAPP_INBOX_ORIGIN !== 'https://13.39.100.55:8445') throw Error('inbox_configuration_invalid');
  const read = key => {
    const filename = env[key];
    if (typeof filename !== 'string' || !filename.startsWith('/etc/clinicaclick-whatsapp-inbox/') || fs.realpathSync(filename) !== filename) throw Error('inbox_configuration_invalid');
    const info = fs.statSync(filename);
    if (!info.isFile() || info.size > 65536 || (info.mode & 0o007)) throw Error('inbox_configuration_invalid');
    return fs.readFileSync(filename);
  };
  return { origin: env.WHATSAPP_INBOX_ORIGIN, ca: read('WHATSAPP_INBOX_CA_FILE'),
    cert: read('WHATSAPP_INBOX_CERT_FILE'), key: read('WHATSAPP_INBOX_KEY_FILE') };
}
function createInboxClient({ origin, ca, cert, key, timeout = 8000 }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('inbox_configuration_invalid');
  const agent = new https.Agent({ ca, cert, key, rejectUnauthorized: true, minVersion: 'TLSv1.2', keepAlive: false, maxSockets: 4 });
  return {
    async request(method, path, body, headers = {}) {
      if (!['GET', 'POST'].includes(method) || !['', '/pending', '/lease', '/confirm'].includes(path)) throw Error('inbox_request_invalid');
      const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      try {
        return await new Promise((resolve, reject) => {
          const req = https.request(new URL('/v1/whatsapp/inbox' + path, url), { method, agent, signal: AbortSignal.timeout(timeout),
            headers: { 'content-type': 'application/json', ...(raw ? { 'content-length': raw.length } : {}), ...headers } }, res => {
            const chunks = []; let bytes = 0;
            res.on('data', part => { bytes += part.length; if (bytes > 5 * 1024 * 1024) { res.destroy(); return; } chunks.push(part); });
            res.on('error', () => reject(Error('inbox_unavailable')));
            res.on('end', () => {
              let data;
              try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
              catch { return reject(Error('inbox_unavailable')); }
              finally { for (const part of chunks) part.fill(0); }
              resolve({ status: res.statusCode, data });
            });
          });
          req.on('error', () => reject(Error('inbox_unavailable'))); req.end(raw);
        });
      } finally { if (raw && !Buffer.isBuffer(body)) raw.fill(0); }
    },
    close() { agent.destroy(); key.fill(0); },
  };
}
module.exports = { clientFiles, createInboxClient };
