'use strict';
const https = require('node:https'); const fs = require('node:fs');
const tls = require('node:tls'); const { X509Certificate, createPrivateKey } = require('node:crypto');
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
  // Freeze the paths at startup. A certificate renewal cannot change the CA,
  // private key, endpoint or role by modifying process.env at runtime.
  const certPath = env.WHATSAPP_INBOX_CERT_FILE;
  return { origin: env.WHATSAPP_INBOX_ORIGIN, ca: read('WHATSAPP_INBOX_CA_FILE'),
    cert: read('WHATSAPP_INBOX_CERT_FILE'), key: read('WHATSAPP_INBOX_KEY_FILE'),
    readCertificate: () => {
      if (fs.realpathSync(certPath) !== certPath) throw Error('inbox_configuration_invalid');
      const fd = fs.openSync(certPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || stat.mode & 0o007) throw Error('inbox_configuration_invalid');
        return fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
    } };
}
function createInboxClient({ origin, ca, cert, key, timeout = 8000, readCertificate,
  report = value => process.stderr.write(JSON.stringify(value) + '\n') }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('inbox_configuration_invalid');
  const original = new X509Certificate(cert); const issuer = new X509Certificate(ca); const privateKey = createPrivateKey(key);
  const make = certificate => ({ cert: certificate, users: 0, retired: false,
    agent: new https.Agent({ ca, cert: certificate, key, rejectUnauthorized: true, minVersion: 'TLSv1.2', keepAlive: false, maxSockets: 4 }) });
  let current = make(cert); let closed = false; let lastFailure = false; const agents = new Set([current]);
  function reportState(status) { try { report({ event: 'whatsapp_inbox_client_certificate', status }); } catch {} }
  const collect = item => { if (item.retired && item.users === 0) { item.agent.destroy(); agents.delete(item); } };
  function acquire() {
    if (closed) throw Error('inbox_unavailable');
    if (readCertificate) try {
      const next = readCertificate();
      if (!Buffer.isBuffer(next) || next.length > 65536) throw Error('certificate_invalid');
      if (!next.equals(current.cert)) {
        const candidate = new X509Certificate(next); const now = Date.now();
        if (candidate.ca || !candidate.checkPrivateKey(privateKey) || candidate.subject !== original.subject
          || candidate.subjectAltName !== original.subjectAltName || JSON.stringify(candidate.keyUsage) !== JSON.stringify(original.keyUsage)
          || !Number.isFinite(Date.parse(candidate.validFrom)) || !Number.isFinite(Date.parse(candidate.validTo))
          || Date.parse(candidate.validFrom) > now || Date.parse(candidate.validTo) <= now
          || !Number.isFinite(Date.parse(issuer.validFrom)) || !Number.isFinite(Date.parse(issuer.validTo))
          || Date.parse(issuer.validFrom) > now || Date.parse(issuer.validTo) < Date.parse(candidate.validTo)
          || !issuer.ca || !candidate.checkIssued(issuer) || !candidate.verify(issuer.publicKey)) throw Error('certificate_invalid');
        tls.createSecureContext({ ca, cert: next, key, minVersion: 'TLSv1.2' });
        const previous = current; current = make(next); agents.add(current); previous.retired = true; collect(previous);
        reportState('reloaded');
      }
      lastFailure = false;
    } catch { if (!lastFailure) reportState('reload_failed'); lastFailure = true; }
    current.users++; return current;
  }
  return {
    async request(method, path, body, headers = {}) {
      if (!['GET', 'POST'].includes(method) || !['', '/pending', '/lease', '/confirm', '/defer'].includes(path)) throw Error('inbox_request_invalid');
      const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const active = acquire();
      try {
        return await new Promise((resolve, reject) => {
          const req = https.request(new URL('/v1/whatsapp/inbox' + path, url), { method, agent: active.agent, signal: AbortSignal.timeout(timeout),
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
      } finally { active.users--; collect(active); if (raw && !Buffer.isBuffer(body)) raw.fill(0); }
    },
    close() { closed = true; for (const item of agents) item.agent.destroy(); agents.clear(); key.fill(0); },
  };
}
module.exports = { clientFiles, createInboxClient };
