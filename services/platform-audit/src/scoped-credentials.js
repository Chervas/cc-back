'use strict';
const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http');
const { sourceRole, identityFor, WRITER_ROLE } = require('./batch');
const { READER_ROLE } = require('./reader');
const ROLES = Object.freeze({ writer: WRITER_ROLE, reader: READER_ROLE });
const SOCKET_ROOT = '/run/clinicaclick-audit-credentials';
function fail() { throw Object.assign(Error('audit_identity_invalid'), { code: 'audit_identity_invalid' }); }
function validateLease(value, kind, sourceRoleArn, now = Date.now()) {
  sourceRole(sourceRoleArn);
  if (!ROLES[kind] || value?.version !== 1 || value.roleArn !== ROLES[kind]) fail();
  identityFor(value.sourceIdentity, sourceRoleArn);
  const c = value.credentials; const expiration = Date.parse(c?.expiration);
  if (!c || typeof c.accessKeyId !== 'string' || !/^ASIA[A-Z0-9]{16}$/.test(c.accessKeyId)
    || typeof c.secretAccessKey !== 'string' || c.secretAccessKey.length !== 40
    || typeof c.sessionToken !== 'string' || c.sessionToken.length < 16 || c.sessionToken.length > 16000
    || !Number.isFinite(expiration) || expiration <= now + 60000 || expiration > now + 901000) fail();
  return { ...value, credentials: { ...c, expiration: new Date(expiration) } };
}
function createClient({ socketPath, brokerUid, kind, sourceRoleArn, agent = false }) {
  if (!ROLES[kind] || !path.isAbsolute(socketPath) || !Number.isInteger(brokerUid) || brokerUid < 1) fail();
  return async () => {
    const parent = path.dirname(socketPath); const dir = fs.statSync(parent); const socket = fs.lstatSync(socketPath);
    if (fs.realpathSync(parent) !== parent || dir.uid !== brokerUid || (dir.mode & 0o077) !== 0o011
      || !socket.isSocket() || socket.uid !== brokerUid || (socket.mode & 0o777) !== 0o660
      || socket.gid !== process.getgid()) fail();
    const value = await new Promise((resolve, reject) => {
      let timer; const denied = () => { clearTimeout(timer); reject(Object.assign(Error('audit_identity_invalid'), { code: 'audit_identity_invalid' })); };
      const req = http.request({ socketPath, path: '/v1/credentials', method: 'GET', agent }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => { size += chunk.length; if (size > 20000) req.destroy(); else chunks.push(chunk); });
        res.on('error', denied); res.on('end', () => { clearTimeout(timer);
          try { if (res.statusCode !== 200) fail(); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { denied(); } });
      });
      req.on('error', denied); timer = setTimeout(() => req.destroy(), 10000); req.end();
    });
    return validateLease(value, kind, sourceRoleArn);
  };
}
function runtimeClient(config, kind) {
  if (config.credentialMode !== 'unix-scoped' || process.env.AWS_EC2_METADATA_DISABLED !== 'true'
    || process.env.AWS_CONFIG_FILE !== '/dev/null' || process.env.AWS_SHARED_CREDENTIALS_FILE !== '/dev/null'
    || Number(process.versions.node.split('.')[0]) !== 24) fail();
  return createClient({ socketPath: `${SOCKET_ROOT}/${kind}.sock`, brokerUid: config.credentialBrokerUid,
    kind, sourceRoleArn: config.brokerSourceRoleArn });
}
module.exports = { ROLES, SOCKET_ROOT, validateLease, createClient, runtimeClient };
