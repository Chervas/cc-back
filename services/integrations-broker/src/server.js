'use strict';

const https = require('node:https');
const { publicError, BrokerError } = require('./errors');
const aiLimits = require('./ai-limits');
function handler(broker, { transportProfile = 'default' } = {}) {
  if (!['default', 'ai'].includes(transportProfile)) throw Error('Invalid transport profile');
  const maxRequestBytes = transportProfile === 'ai' ? aiLimits.MAX_REQUEST_BYTES : 32768;
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let size = 0; const chunks = [];
    try {
      if (req.method !== 'POST' || req.url !== '/v1/execute' || req.headers['content-type'] !== 'application/json'
        || req.headers['content-encoding'] || req.headers['transfer-encoding']) throw new BrokerError('invalid_request');
      if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length'])
        || Number(req.headers['content-length']) > maxRequestBytes)) throw new BrokerError('invalid_request');
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxRequestBytes) throw new BrokerError('invalid_request');
        chunks.push(chunk);
      }
      const result = await broker.execute(Buffer.concat(chunks), req.headers);
      res.writeHead(200); res.end(JSON.stringify(result));
    } catch (error) {
      const result = publicError(error);
      if (!res.headersSent) res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    }
  };
}
function createServer(broker, tls, options = {}) {
  if (!tls?.cert || !tls?.key) throw Error('TLS identity required');
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, handler(broker, options));
  server.requestTimeout = options.transportProfile === 'ai' ? 30000 : 15000;
  server.headersTimeout = 10000; server.timeout = options.transportProfile === 'ai' ? aiLimits.MAX_TIMEOUT_MS + 5000 : 20000;
  server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  return server;
}
module.exports = { createServer, handler };
