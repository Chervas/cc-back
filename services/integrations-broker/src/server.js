'use strict';

const https = require('node:https');
const { publicError, BrokerError } = require('./errors');
function handler(broker) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let size = 0; const chunks = [];
    try {
      if (req.method !== 'POST' || req.url !== '/v1/execute' || req.headers['content-type'] !== 'application/json'
        || req.headers['content-encoding'] || req.headers['transfer-encoding']) throw new BrokerError('invalid_request');
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) throw new BrokerError('invalid_request');
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
function createServer(broker, tls) {
  if (!tls?.cert || !tls?.key) throw Error('TLS identity required');
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, handler(broker));
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.timeout = 20000;
  server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  return server;
}
module.exports = { createServer, handler };
