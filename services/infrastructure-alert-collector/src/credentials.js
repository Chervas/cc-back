'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { ACCOUNT, CREDENTIALS_PROCESS, fail } = require('./scope');
function validateCredentials(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['Version', 'AccessKeyId', 'SecretAccessKey', 'SessionToken', 'Expiration', 'AccountId'].includes(key))
    || value.Version !== 1 || !/^ASIA[A-Z0-9]{16}$/.test(value.AccessKeyId)
    || typeof value.SecretAccessKey !== 'string' || !/^[A-Za-z0-9/+=]{40}$/.test(value.SecretAccessKey)
    || typeof value.SessionToken !== 'string' || value.SessionToken.length < 16 || value.SessionToken.length > 8192
    || /\s/.test(value.SessionToken) || typeof value.Expiration !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value.Expiration)
    || value.AccountId !== undefined && value.AccountId !== ACCOUNT) fail('alerts_credentials_invalid');
  const expiration = new Date(value.Expiration); const remaining = expiration.getTime() - now;
  if (!Number.isFinite(remaining) || remaining < 60000 || remaining > 3600000) fail('alerts_credentials_invalid');
  return { accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey, sessionToken: value.SessionToken, expiration };
}
function checkCredentialsProcess(fsImpl = fs) {
  for (const directory of ['/', '/usr', '/usr/local', '/usr/local/libexec']) {
    const info = fsImpl.lstatSync(directory);
    if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o022) fail('alerts_credentials_unavailable');
  }
  const info = fsImpl.lstatSync(CREDENTIALS_PROCESS);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o7777) !== 0o755 || info.nlink !== 1) fail('alerts_credentials_unavailable');
}
function createCredentialsProcessProvider({ execute = execFile, fsImpl = fs, now = Date.now, signal } = {}) {
  let cached; let pending;
  return async () => {
    if (signal?.aborted) fail('alerts_timeout');
    if (cached && cached.expiration.getTime() - now() > 120000) return cached;
    if (!pending) pending = new Promise((resolve, reject) => {
      try { checkCredentialsProcess(fsImpl); } catch { reject(Error('alerts_credentials_unavailable')); return; }
      const child = execute(CREDENTIALS_PROCESS, [], { timeout: 8000, maxBuffer: 16384, encoding: 'utf8', signal,
        env: { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' } }, (error, stdout) => {
        if (error) { reject(Error(signal?.aborted ? 'alerts_timeout' : 'alerts_credentials_unavailable')); return; }
        try { cached = validateCredentials(JSON.parse(stdout), now()); resolve(cached); }
        catch { reject(Error('alerts_credentials_invalid')); }
      });
      child?.stdin?.on('error', () => {}); child?.stdin?.end();
    }).finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { validateCredentials, checkCredentialsProcess, createCredentialsProcessProvider };
