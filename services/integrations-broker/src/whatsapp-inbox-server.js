'use strict';
const https = require('node:https');
const { createHash } = require('node:crypto');
const { BrokerError, fail, publicError } = require('./errors');
const { createWhatsappInboxHandler } = require('./whatsapp-inbox-http');
const BASE = '/v1/whatsapp/inbox';
const EXACT_PRINCIPALS = ['gateway:whatsapp-inbox', 'staging:whatsapp-inbox'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys;
function validatePrincipals(principals) {
  if (!Array.isArray(principals) || principals.length !== 2
    || [...principals.map(p => p.id)].sort().join(',') !== EXACT_PRINCIPALS.join(',')
    || principals.some(p => !exact(p, 'certificateSha256,id,maxPerMinute') || !/^[a-f0-9]{64}$/.test(p.certificateSha256)
      || !Number.isInteger(p.maxPerMinute) || p.maxPerMinute < 1 || p.maxPerMinute > 600)
    || new Set(principals.map(p => p.certificateSha256)).size !== 2) fail('invalid_request');
  return structuredClone(principals);
}
function respond(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
  if (status >= 500 || status === 429) res.setHeader('Retry-After', '60');
  res.end(JSON.stringify(value));
}
async function jsonBody(req, keys) {
  const chunks = []; let raw;
  try {
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
      || !['', 'identity'].includes(String(req.headers['content-encoding'] || '').toLowerCase())) fail('invalid_request');
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length; if (bytes > 1024) fail('invalid_request'); chunks.push(chunk);
    }
    raw = Buffer.concat(chunks); const body = JSON.parse(raw.toString('utf8'));
    if (!exact(body, keys)) fail('invalid_request'); return body;
  } catch { fail('invalid_request'); }
  finally { raw?.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
function createInboxServer({ inbox, withApplicationSecret, principals, cert, key, ca, consumerEnabled = false, now = () => Date.now() }) {
  const allowed = validatePrincipals(principals); const windows = new Map();
  if (!Buffer.isBuffer(cert) || !Buffer.isBuffer(key) || !Buffer.isBuffer(ca) || typeof consumerEnabled !== 'boolean'
    || ['accept', 'pending', 'lease', 'confirm'].some(name => typeof inbox?.[name] !== 'function')) fail('invalid_request');
  const receive = createWhatsappInboxHandler({ inbox, withApplicationSecret });
  let inFlight = 0;
  const server = https.createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    maxHeaderSize: 8192 }, async (req, res) => {
    let occupied = false; let lease;
    try {
      const peer = req.socket.getPeerCertificate();
      if (!req.socket.authorized || !peer?.raw || !Number.isFinite(Date.parse(peer.valid_to))
        || !Number.isFinite(Date.parse(peer.valid_from)) || Date.parse(peer.valid_to) <= now() || Date.parse(peer.valid_from) > now()) fail('invalid_signature');
      const fingerprint = createHash('sha256').update(peer.raw).digest('hex');
      const principal = allowed.find(p => p.certificateSha256 === fingerprint);
      if (!principal) fail('scope_denied');
      // Authorization precedes body consumption. A gateway certificate cannot
      // list, decrypt, lease or acknowledge the consumer's clinical payloads.
      const route = req.method + ' ' + req.url;
      const ingress = route === 'POST ' + BASE;
      const consumer = ['GET ' + BASE + '/pending', 'POST ' + BASE + '/lease', 'POST ' + BASE + '/confirm'].includes(route);
      if (!(ingress && principal.id === EXACT_PRINCIPALS[0] || consumer && principal.id === EXACT_PRINCIPALS[1])) fail('operation_denied');
      if (consumer && !consumerEnabled) fail('provider_disabled');
      const minute = Math.floor(now() / 60000); let window = windows.get(principal.id);
      if (window?.minute !== minute) windows.set(principal.id, window = { minute, count: 0 });
      if (window.count++ >= principal.maxPerMinute || inFlight >= 8) fail('rate_limited');
      inFlight++; occupied = true;
      if (ingress) return await receive(req, res);
      if (req.method === 'GET') return respond(res, 200, { receipts: inbox.pending(20), automaticActionsAllowed: false });
      if (req.url === BASE + '/lease') {
        const body = await jsonBody(req, 'receipt'); lease = inbox.lease(body.receipt);
        const { raw, ...metadata } = lease;
        return respond(res, 200, { ...metadata, rawBase64: raw.toString('base64') });
      }
      const body = await jsonBody(req, 'importReceipt,lease,receipt');
      return respond(res, 200, inbox.confirm(body));
    } catch (error) {
      const safe = publicError(error instanceof BrokerError ? error : new BrokerError('audit_unavailable'));
      return respond(res, safe.status, safe.body);
    } finally { lease?.raw.fill(0); if (occupied) inFlight--; }
  });
  server.maxConnections = 64; server.requestTimeout = 15000; server.headersTimeout = 10000;
  server.timeout = 15000; server.keepAliveTimeout = 1000;
  return server;
}
module.exports = { BASE, validatePrincipals, createInboxServer };
