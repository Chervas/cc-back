'use strict';

// Shared, byte-identical with platform-audit/src/tls-reload.js. Both services
// ship as independent artifacts; test/tls-reload.test.js checks the mirror.
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { X509Certificate, createPrivateKey } = require('node:crypto');
const DAY = 86400000;
function invalid() { throw Error('tls_renewal_invalid'); }
function privateFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 65536 || stat.nlink !== 1
      || ![0, process.geteuid()].includes(stat.uid)) invalid();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function validateSettings(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'issuerCaFile'
    || typeof value.issuerCaFile !== 'string' || !path.isAbsolute(value.issuerCaFile)
    || path.normalize(value.issuerCaFile) !== value.issuerCaFile) invalid();
  return value;
}
function certificates(pem) {
  const blocks = pem.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > 4 || pem.toString('utf8').replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) invalid();
  return blocks.map(block => new X509Certificate(block));
}
function identity(cert) {
  return JSON.stringify([cert.subject, cert.subjectAltName || '', cert.ca, [...(cert.keyUsage || [])].sort(),
    cert.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]);
}
function install(server, config, initial, { now = Date.now, report = event => process.stderr.write(JSON.stringify(event) + '\n'),
  signals = process, intervalMs = 60000 } = {}) {
  if (!Object.hasOwn(config, 'tlsRenewal')) return null;
  validateSettings(config.tlsRenewal);
  const issuers = certificates(privateFile(config.tlsRenewal.issuerCaFile));
  const original = certificates(initial.cert);
  if (original.length !== 1 || typeof server.setSecureContext !== 'function') invalid();
  const privateKey = createPrivateKey(initial.key); const expected = identity(original[0]);
  function validate(pem, minimumRemaining = 0) {
    const chain = certificates(pem); const leaf = chain[0]; const at = now();
    if (chain.length !== 1 || identity(leaf) !== expected || !leaf.checkPrivateKey(privateKey)
      || leaf.validFromDate.getTime() > at || leaf.validToDate.getTime() <= at + minimumRemaining
      || !issuers.some(ca => ca.validFromDate.getTime() <= at && ca.validToDate.getTime() >= leaf.validToDate.getTime()
        && ca.ca && leaf.checkIssued(ca) && leaf.verify(ca.publicKey))) invalid();
    return leaf;
  }
  let current = validate(initial.cert); let stopped = false; let lastReport = '';
  const options = { ...initial, key: Buffer.from(initial.key), minVersion: 'TLSv1.2' };
  const emit = (status, cert = current) => {
    const event = { event: 'tls_certificate_maintenance', status, fingerprint: cert.fingerprint256,
      expiresAt: cert.validToDate.toISOString() };
    const key = JSON.stringify(event);
    if (key !== lastReport) { lastReport = key; try { report(event); } catch { /* reporting must not drop traffic */ } }
  };
  const reload = () => {
    if (stopped) return false;
    try {
      const pem = privateFile(config.tlsCertFile); const candidate = validate(pem);
      if (candidate.fingerprint256 !== current.fingerprint256) {
        validate(pem, DAY); // Never switch to an almost expired certificate.
        // Validate first. setSecureContext affects new handshakes, not live
        // sockets, requests, provider calls, queues or business state.
        tls.createSecureContext({ ...options, cert: pem });
        server.setSecureContext({ ...options, cert: pem });
        current = candidate; emit('reloaded');
      } else if (current.validToDate.getTime() - now() < 7 * DAY) emit('expiring');
      else emit('healthy');
      return true;
    } catch { emit('reload_failed'); return false; }
  };
  const signal = () => { reload(); };
  signals.on('SIGHUP', signal);
  const timer = setInterval(reload, intervalMs); timer.unref();
  const close = () => { if (!stopped) { stopped = true; clearInterval(timer); signals.removeListener('SIGHUP', signal); options.key.fill(0); } };
  server.once('close', close);
  return { reload, close, status: () => ({ fingerprint: current.fingerprint256, expiresAt: current.validToDate.toISOString() }) };
}
module.exports = { install, validateSettings, privateFile };
