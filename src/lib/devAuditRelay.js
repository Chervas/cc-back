'use strict';
const http = require('node:http');
const { UUID, receiptFor } = require('../../services/platform-audit/src/event');
const SOCKET = '/var/lib/clinicaclick-dev-security/audit.sock';
const denied = () => { throw Object.assign(Error('audit_reader_denied'), { code: 'audit_reader_denied' }); };
// The API never receives the remote reader's key. The relay only accepts receipts
// indexed in DEV and a current DEV session, even if a public S3 key is known.
async function authorize(command, { findEvent, verifySession }) {
  if (!command || Object.keys(command).sort().join(',') !== 'actorId,mode,refs,requestId,sessionRef'
    || command.mode !== 'confirmed' || !['1', '44'].includes(command.actorId)
    || !UUID.test(command.requestId) || !UUID.test(command.sessionRef)
    || !Array.isArray(command.refs) || !command.refs.length || command.refs.length > 25) denied();
  await verifySession({ userId: Number(command.actorId), sessionRef: command.sessionRef, expiresAt: new Date(Date.now() + 1) });
  for (const ref of command.refs) {
    if (!ref || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) denied();
    const row = await findEvent(ref.digest);
    if (!row || row.state !== 'delivered') denied();
    const saved = typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt;
    receiptFor(row, ref);
    if (!saved || ['key', 'digest', 'versionId'].some(k => saved[k] !== ref[k])) denied();
  }
  return true;
}
function read(command, env) {
  if (env.RUNTIME_NAMESPACE !== 'dev' || env.DB_NAME !== 'clinicaclick_dev_isolated'
    || env.PLATFORM_AUDIT_READER_SOCKET !== SOCKET) denied();
  const raw = Buffer.from(JSON.stringify(command));
  return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(Error('audit_reader_unavailable'), { code: 'audit_reader_unavailable' }));
    const req = http.request({ socketPath: SOCKET, path: '/audit/read', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': raw.length } }, res => {
      let size = 0; const chunks = [];
      res.on('data', b => { size += b.length; if (size > 300000) req.destroy(); else chunks.push(b); });
      res.on('error', fail); res.on('end', () => {
        try { if (res.statusCode !== 200) return fail(); resolve(JSON.parse(Buffer.concat(chunks))); } catch { fail(); }
      });
    });
    req.setTimeout(25000, () => req.destroy()); req.on('error', fail); req.end(raw);
  });
}
module.exports = { SOCKET, authorize, read };
