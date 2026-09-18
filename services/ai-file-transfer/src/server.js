'use strict';
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const C = require('./contract');
function headers(res) {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}
function failure(res, code, status) {
  if (res.headersSent || res.destroyed) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ error: code }));
}
function range(value, size) {
  if (value === undefined) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) C.fail('invalid_range');
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if (first !== null && !Number.isSafeInteger(first) || last !== null && !Number.isSafeInteger(last)) C.fail('invalid_range');
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if (start < 0 || start >= size || end < start) C.fail('invalid_range');
  return { start, end, partial: true };
}
function controlHandler(store) {
  return async (req, res) => {
    headers(res);
    try {
      if (req.method === 'GET' && req.url === '/v1/status') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(store.status())); return;
      }
      if (req.method === 'DELETE' && req.url.startsWith('/v1/transfers/')) {
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) C.fail('invalid_request');
        await store.revoke(req.url.slice('/v1/transfers/'.length)); res.writeHead(204); res.end(); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/transfers' || req.headers['content-type'] !== 'application/octet-stream'
        || req.headers['content-encoding'] || req.headers['transfer-encoding']) C.fail('invalid_request');
      const encoded = req.headers['x-cc-transfer-metadata'];
      if (typeof encoded !== 'string' || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) C.fail('invalid_request');
      let input; try { input = C.upload(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); } catch { C.fail('invalid_request'); }
      if (String(input.sizeBytes) !== req.headers['content-length']) C.fail('invalid_request');
      const reference = await store.create(input, req);
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(reference));
    } catch (error) {
      const code = ['rate_limited', 'invalid_request', 'not_found'].includes(error.code) ? error.code : 'transfer_unavailable';
      failure(res, code, { rate_limited: 429, invalid_request: 400, not_found: 404 }[code] || 503);
    }
  };
}
function downloadHandler(store, { maxDownloads = 4, transferTimeoutMs = 30000 } = {}) {
  let active = 0;
  return async (req, res) => {
    headers(res); let admitted = false, row, cancel, timer, file;
    try {
      if (!['GET', 'HEAD'].includes(req.method) || !req.url.startsWith(C.PREFIX)
        || req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0) C.fail('not_found');
      const token = req.url.slice(C.PREFIX.length); const found = store.lookup(token); row = found.row;
      if (active >= maxDownloads || row.requestCount >= 16) C.fail('rate_limited');
      const span = range(req.method === 'HEAD' ? undefined : req.headers.range, row.input.sizeBytes);
      const size = span.end - span.start + 1;
      if (req.method !== 'HEAD' && row.bytesReserved + size > row.input.sizeBytes * 3) C.fail('rate_limited');
      admitted = true; active++; row.requestCount++;
      if (req.method !== 'HEAD') row.bytesReserved += size;
      cancel = () => { res.destroy(); }; row.consumers.add(cancel);
      timer = setTimeout(cancel, Math.min(transferTimeoutMs, Math.max(1, row.expiresAt - store.now()))); timer.unref();
      file = await store.verifiedFile(found.id, row);
      if (!row.ready || row.expiresAt <= store.now() || res.destroyed) C.fail('not_found');
      res.setHeader('Content-Type', row.input.mimeType); res.setHeader('Content-Length', size);
      res.setHeader('Content-Disposition', 'attachment'); res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('ETag', `"${row.input.sha256}"`);
      if (span.partial) res.setHeader('Content-Range', `bytes ${span.start}-${span.end}/${row.input.sizeBytes}`);
      res.writeHead(span.partial ? 206 : 200);
      if (req.method === 'HEAD') res.end();
      else {
        const stream = file.createReadStream({ start: span.start, end: span.end, highWaterMark: 65536, autoClose: false });
        await pipeline(stream, res);
      }
    } catch (error) {
      if (error.code === 'invalid_range') { if (row) res.setHeader('Content-Range', `bytes */${row.input.sizeBytes}`); failure(res, 'invalid_range', 416); }
      else if (error.code === 'rate_limited') failure(res, 'rate_limited', 429);
      else failure(res, 'not_found', 404);
    } finally {
      clearTimeout(timer); if (cancel) row.consumers.delete(cancel); if (file) await file.close().catch(() => {});
      if (admitted) active--;
    }
  };
}
function server(handler, { control = false } = {}) {
  const instance = http.createServer({ maxHeaderSize: 4096 }, handler);
  instance.maxConnections = control ? 16 : 32; instance.requestTimeout = control ? 30000 : 10000;
  instance.headersTimeout = 5000; instance.timeout = 35000; instance.keepAliveTimeout = 1000; instance.maxRequestsPerSocket = 20;
  // Parser errors must not include raw headers, URLs or capability tokens.
  instance.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return instance;
}
module.exports = { controlHandler, downloadHandler, server, range };
