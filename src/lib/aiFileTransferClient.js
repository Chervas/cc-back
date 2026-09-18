'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const C = require('../../services/ai-file-transfer/src/contract');
const fail = code => { throw Object.assign(Error(code), { code }); };
function configuration(filename) {
  try {
    if (!filename || !path.isAbsolute(filename) || fs.realpathSync(filename) !== filename) throw Error();
    const info = fs.statSync(filename);
    if (!info.isFile() || info.mode & 0o077 || info.size > 8192 || ![0, process.getuid()].includes(info.uid)) throw Error();
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!C.exact(value, ['version', 'environment', 'origin', 'controlSocket', 'serverUid']) || value.version !== 1
      || !['dev', 'staging'].includes(value.environment) || !path.isAbsolute(value.controlSocket) || !Number.isInteger(value.serverUid) || value.serverUid < 1) throw Error();
    C.origin(value.origin); return value;
  } catch { fail('file_transfer_configuration_invalid'); }
}
function createClient({ config, now = Date.now, onCleanupFailure = () => process.stderr.write('AI_TRANSFER_RELEASE_PENDING\n') }) {
  function request(method, requestPath, input, buffer) {
    try {
      const socket = fs.lstatSync(config.controlSocket);
      if (!socket.isSocket() || socket.uid !== config.serverUid || socket.mode & 0o007 || fs.realpathSync(config.controlSocket) !== config.controlSocket) throw Error();
    } catch { return Promise.reject(Object.assign(Error('file_transfer_unavailable'), { code: 'file_transfer_unavailable' })); }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const bad = code => Object.assign(Error(code), { code });
      const req = http.request({ socketPath: config.controlSocket, method, path: requestPath, agent: false,
        headers: { 'content-length': buffer?.length || 0, ...(input ? { 'content-type': 'application/octet-stream',
          'x-cc-transfer-metadata': Buffer.from(JSON.stringify(input)).toString('base64url') } : {}) } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 16384) req.destroy(); else chunks.push(chunk); });
        res.on('error', () => finish(bad('file_transfer_unavailable'))); res.on('aborted', () => finish(bad('file_transfer_unavailable')));
        res.on('end', () => {
          if (method === 'DELETE' && res.statusCode === 204) return finish(null);
          if (res.statusCode !== 201) return finish(bad(res.statusCode === 429 ? 'rate_limited' : 'file_transfer_unavailable'));
          try {
            const value = JSON.parse(Buffer.concat(chunks));
            C.reference(value, { expectedOrigin: config.origin, environment: config.environment, requestId: input.requestId, useCase: input.useCase, now: now() });
            if (Object.keys(input).some(key => input[key] !== value[key])) throw Error();
            finish(null, value);
          } catch { finish(bad('file_transfer_response_invalid')); }
        });
      });
      const timer = setTimeout(() => { finish(bad('file_transfer_unavailable')); req.destroy(); }, 30000); timer.unref?.();
      req.on('error', () => finish(bad('file_transfer_unavailable'))); req.end(buffer);
    });
  }
  return {
    async withTransfer({ useCase, buffer, mimeType, fileName, requestId = randomUUID() }, callback) {
      if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > C.MAX_FILE_BYTES) fail('invalid_request');
      const input = C.upload({ useCase, requestId, mimeType, fileName, sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
      const reference = await request('POST', '/v1/transfers', input, buffer);
      try { return await callback(reference); }
      finally {
        const token = reference.url.slice((config.origin + C.PREFIX).length);
        try { await request('DELETE', '/v1/transfers/' + token); } catch { try { onCleanupFailure(); } catch {} }
      }
    },
  };
}
module.exports = { createClient, configuration };
