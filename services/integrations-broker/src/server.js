'use strict';

const https = require('node:https');
const { publicError, BrokerError } = require('./errors');
const aiLimits = require('./ai-limits');
const emailLimits = require('./email-limits');
const publicMediaLimits = require('./public-media-limits');
function handler(broker, { transportProfile = 'default' } = {}) {
  if (!['default', 'ai', 'email', 'public-media'].includes(transportProfile)) throw Error('Invalid transport profile');
  const limits = transportProfile === 'ai' ? aiLimits : transportProfile === 'email' ? emailLimits
    : transportProfile === 'public-media' ? publicMediaLimits : null;
  const maxRequestBytes = limits ? limits.MAX_REQUEST_BYTES : 32768;
  let activeRequests = 0, pendingBytes = 0;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let size = 0; const chunks = [];
    let admitted = false, reservedBytes = 0, workFinished = false, responseFinished = false;
    const release = () => {
      if (!admitted || !workFinished || !responseFinished) return;
      admitted = false; activeRequests--; pendingBytes -= reservedBytes;
    };
    try {
      if (req.method !== 'POST' || req.url !== '/v1/execute' || req.headers['content-type'] !== 'application/json'
        || req.headers['content-encoding'] || req.headers['transfer-encoding']) throw new BrokerError('invalid_request');
      if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length'])
        || Number(req.headers['content-length']) > maxRequestBytes)) throw new BrokerError('invalid_request');
      if (limits) {
        reservedBytes = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 1 || reservedBytes > maxRequestBytes) throw new BrokerError('invalid_request');
        if (activeRequests >= limits.MAX_CONCURRENT_REQUESTS
          || pendingBytes + reservedBytes > limits.MAX_PENDING_REQUEST_BYTES) throw new BrokerError('rate_limited');
        admitted = true; activeRequests++; pendingBytes += reservedBytes;
        // A disconnected caller does not cancel provider work or free capacity
        // while that work is still running. Slow responses retain their slot.
        const finished = () => { responseFinished = true; release(); };
        res.once('finish', finished); res.once('close', finished);
      }
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestBytes || admitted && size > reservedBytes) throw new BrokerError('invalid_request');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks); chunks.length = 0;
      const result = await broker.execute(raw, req.headers);
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch (error) {
      const result = publicError(error);
      // Rejected uploads must not keep streaming on a reusable connection.
      if (limits && !res.headersSent) res.setHeader('Connection', 'close');
      if (!res.headersSent) res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    } finally {
      chunks.length = 0; workFinished = true;
      responseFinished ||= res.writableFinished || res.destroyed;
      release();
    }
  };
}
function createServer(broker, tls, options = {}) {
  if (!tls?.cert || !tls?.key) throw Error('TLS identity required');
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, handler(broker, options));
  server.requestTimeout = ['ai', 'public-media'].includes(options.transportProfile) ? 30000 : 15000;
  server.headersTimeout = 10000; server.timeout = options.transportProfile === 'ai' ? aiLimits.MAX_TIMEOUT_MS + 5000
    : options.transportProfile === 'email' ? emailLimits.MAX_TIMEOUT_MS + 5000
      : options.transportProfile === 'public-media' ? publicMediaLimits.MAX_TIMEOUT_MS + 5000 : 20000;
  server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  return server;
}
module.exports = { createServer, handler };
