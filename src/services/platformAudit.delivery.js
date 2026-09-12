'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { execFile } = require('node:child_process');
const { inputFor, resultFor, sourceRole, safeError } = require('../../services/platform-audit/src/batch');
const { unpack, fail } = require('../../services/platform-audit/src/event');
function invokeWriter(config, records, execute = execFile) {
  const input = inputFor({ version: 1, sourceRoleArn: config.sourceRoleArn,
    records: records.map(row => ({ body: row.body, digest: row.digest })) });
  try { if (!path.isAbsolute(config.nodeBinary) || !fs.statSync(config.nodeBinary).isFile()) fail('audit_configuration_invalid'); }
  catch { fail('audit_configuration_invalid'); }
  return new Promise((resolve, reject) => {
    const child = execute(config.nodeBinary, [path.resolve(__dirname, '../../services/platform-audit/src/writer-main.js')], {
      timeout: 75000, killSignal: 'SIGKILL', maxBuffer: 128000, encoding: 'utf8',
      // Deliberate allowlist: no application secrets, .env, AWS/SSO keys, proxy, endpoint or TLS overrides.
      env: { PATH: '/usr/bin:/bin', TZ: 'UTC', AWS_EC2_METADATA_V1_DISABLED: 'true',
        AWS_EC2_METADATA_SERVICE_ENDPOINT: 'http://169.254.169.254',
        AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' },
    }, (error, stdout) => {
      try {
        const value = JSON.parse(stdout);
        if (error || value.ok !== true) return reject(Object.assign(Error('audit_writer_unavailable'), { code: safeError({ code: value.error }) }));
        resolve(resultFor(input, value.batch));
      } catch { reject(Object.assign(Error('audit_writer_unavailable'), { code: 'audit_unavailable' })); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
}
function createDelivery({ repository, state, write = invokeWriter, config = () => ({}), now = () => new Date() }) {
  return {
    async run() {
      const settings = config();
      if (settings.enabled !== true) return { status: 'completed', skipped: true, reason: 'audit_delivery_disabled' };
      let lease; let delivered = 0; let failed = 0; let code = null; const rows = [];
      try {
        sourceRole(settings.sourceRoleArn);
        lease = await state.acquire(now());
        if (!lease) return { status: 'completed', skipped: true, reason: 'audit_delivery_in_progress' };
        const deadline = now().getTime() + 15000;
        while (rows.length < 50 && now().getTime() < deadline) {
          const row = await repository.claim(now()); if (!row) break;
          try { unpack(row); rows.push(row); }
          catch { code = 'audit_integrity_invalid'; await repository.retry(row, code, now()); failed++; break; }
        }
        if (rows.length) {
          let batch;
          try {
            batch = resultFor({ version: 1, sourceRoleArn: settings.sourceRoleArn,
              records: rows.map(row => ({ body: row.body, digest: row.digest })) }, await write(settings, rows));
          } catch (error) { code = safeError(error); }
          for (const [index, row] of rows.entries()) {
            const result = batch?.results[index];
            try {
              if (result?.status === 'delivered' && await repository.acknowledge(row, result.receipt, now())) { delivered++; continue; }
              await repository.retry(row, result?.error || code || 'audit_unavailable', now());
            } catch { code = 'audit_unavailable'; /* Lease expires; keep unknown commits, never delete the row. */ }
            failed++;
          }
        }
        const summary = { delivered, failed, ...await repository.health(now()) };
        if (!await state.finish(lease, summary, code || (failed ? 'audit_unavailable' : null), now(),
          { preserveError: rows.length === 0 && !code && failed === 0 })) fail('audit_unavailable');
        return { status: failed || code ? 'failed' : 'completed', retryable: false, ...summary, error: code };
      } catch (error) {
        code = safeError(error);
        if (lease) { try { await state.finish(lease, null, code, now()); } catch {} }
        return { status: 'failed', retryable: false, delivered, failed, error: code };
      }
    },
  };
}
let singleton;
module.exports = { invokeWriter, createDelivery,
  run() {
    if (process.env.PLATFORM_AUDIT_DELIVERY_ENABLED !== 'true') return Promise.resolve({ status: 'completed', skipped: true, reason: 'audit_delivery_disabled' });
    if (!singleton) {
      const models = require('../../models');
      singleton = createDelivery({ repository: require('./platformAudit.repository').createRepository(models.PlatformAuditEvent),
        state: require('./platformAudit.monitor').createStateRepository(models), config: () => ({ enabled: true,
          sourceRoleArn: process.env.PLATFORM_AUDIT_WRITER_SOURCE_ROLE_ARN, nodeBinary: process.env.PLATFORM_AUDIT_NODE_BINARY }) });
    }
    return singleton.run();
  },
};
