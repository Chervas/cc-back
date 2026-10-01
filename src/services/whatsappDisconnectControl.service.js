'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const runtime = require('../lib/whatsappAuthorizedRuntime');
const ROOT = '/opt/clinicaclick-whatsapp-disconnect';
const SCRIPT = ROOT + '/src/scripts/whatsapp_disconnect_control.js';
const REVOKE = 'meta.whatsapp.authorized.phone.revoke.v1';
const invalid = () => Object.assign(Error('whatsapp_disconnect_unavailable'), { code: 'whatsapp_disconnect_unavailable' });
function available() {
  try {
    if (runtime.namespace(process.env) !== 'staging') return false;
    for (const file of [ROOT, SCRIPT, ROOT + '/READY']) {
      const stat = fs.statSync(file);
      if (fs.realpathSync(file) !== file || stat.uid !== 0 || stat.mode & 0o022) return false;
    }
    return true;
  } catch { return false; }
}
function execute(command) {
  if (!available() || command.operation !== REVOKE || Object.keys(command.payload || {}).length) return Promise.reject(invalid());
  return new Promise((resolve, reject) => {
    // No shell or caller-controlled executable/environment. The root-owned
    // helper can only revoke a broker asset, never read credentials or send.
    const child = spawn('/usr/bin/sudo', ['-n', '/usr/bin/node', SCRIPT], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(invalid()); }, 12000);
    child.on('error', () => finish(invalid()));
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.length > 4096) { child.kill('SIGTERM'); finish(invalid()); }
    });
    child.stdin.on('error', () => finish(invalid()));
    child.on('close', code => {
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.requestId !== command.requestId || result.data?.revoked !== true
          || Object.keys(result.data).join(',') !== 'revoked' || typeof result.replayed !== 'boolean') throw invalid();
        finish(null, result);
      } catch { finish(invalid()); }
    });
    child.stdin.end(JSON.stringify(command));
  });
}
module.exports = { available, execute };
